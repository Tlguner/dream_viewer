import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { 
  QueueDriverType, 
  GpuJobType,
  GpuJobData, 
  KeyframeJobData,
  VideoJobData,
  GpuJobStatusResponse, 
  VideoJobStatusResponse,
  DreamVideoResult,
  KeyframeOption,
  DreamProgressEvent 
} from '../types/index.js';

export type JobProcessor = (
  jobData: GpuJobData, 
  onProgress: (event: DreamProgressEvent) => void
) => Promise<any>;

export interface IDreamQueue {
  driver: QueueDriverType;
  addJob(data: GpuJobData): Promise<{ jobId: string; queuePosition: number }>;
  waitForJobResult<T = any>(jobId: string): Promise<T>;
  getJobStatus(jobId: string): Promise<GpuJobStatusResponse | null>;
  getQueueStats(): Promise<{ waiting: number; active: number; concurrency: number; driver: QueueDriverType }>;
  close(): Promise<void>;
}

/**
 * BullMQ Production Queue (Requires active Redis)
 * Strictly throws if Redis is unreachable on boot when QUEUE_DRIVER=bullmq
 * Runtime client separates startup check from persistent reconnect strategy.
 */
export class BullMQDreamQueue implements IDreamQueue {
  public driver: QueueDriverType = 'bullmq';
  private queue: Queue;
  private worker: Worker;
  private redisClient: Redis;
  private jobStatuses = new Map<string, GpuJobStatusResponse>();
  private jobDeferreds = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void; promise: Promise<any> }>();

  constructor(
    private redisHost: string,
    private redisPort: number,
    private redisPassword: string | undefined,
    processor: JobProcessor
  ) {
    // Runtime connection with resilient reconnect strategy (not fail-fast retryStrategy: null)
    this.redisClient = new Redis({
      host: redisHost,
      port: redisPort,
      password: redisPassword || undefined,
      maxRetriesPerRequest: null,
      retryStrategy: (times) => {
        console.warn(`⚠️ [BullMQ] Redis reconnect attempt #${times}...`);
        return Math.min(times * 250, 3000);
      }
    });

    this.queue = new Queue('dream_gpu_jobs', {
      connection: this.redisClient
    });

    this.worker = new Worker(
      'dream_gpu_jobs',
      async (job: Job<GpuJobData>) => {
        const isKeyframes = job.data.jobType === 'KEYFRAMES';
        console.log(`🎬 [BullMQ] Worker started processing ${job.data.jobType} job ${job.data.jobId} for dream ${job.data.dreamId} (Concurrency: 1)`);
        
        this.updateJobState(job.data.jobId, {
          status: 'rendering',
          queuePosition: 0,
          stageLabel: isKeyframes ? 'Generating Keyframe Visions on GPU' : 'GPU Video Synthesis Started'
        });

        const deferred = this.jobDeferreds.get(job.data.jobId);

        try {
          const result = await processor(job.data, (prog) => {
            this.updateJobState(job.data.jobId, {
              progress: prog.percent,
              currentScene: prog.currentScene || 1,
              totalScenes: prog.totalScenes || 1,
              stageLabel: prog.stageLabel || prog.detail
            });
            job.updateProgress(prog.percent).catch(() => {});
          });

          const patch: Partial<GpuJobStatusResponse> = {
            status: 'completed',
            progress: 100,
            result
          };
          if (isKeyframes) {
            patch.keyframes = result as KeyframeOption[];
          } else {
            patch.videoUrl = (result as DreamVideoResult).videoUrl;
          }

          this.updateJobState(job.data.jobId, patch);
          deferred?.resolve(result);
          return result;
        } catch (err: any) {
          deferred?.reject(err);
          throw err;
        } finally {
          this.jobDeferreds.delete(job.data.jobId);
        }
      },
      {
        connection: this.redisClient,
        concurrency: 1 // Strict WAN 2.2 GPU concurrency guard: exactly 1 GPU task (video or keyframe) at a time
      }
    );

    this.worker.on('failed', (job, err) => {
      if (job?.data?.jobId) {
        console.error(`💥 [BullMQ] Job ${job.data.jobId} failed:`, err);
        this.updateJobState(job.data.jobId, {
          status: 'failed',
          error: err.message
        });
      }
    });
  }

  public async initialize(): Promise<void> {
    // Isolated startup probe to verify Redis availability immediately on startup
    const probe = new Redis({
      host: this.redisHost,
      port: this.redisPort,
      password: this.redisPassword || undefined,
      maxRetriesPerRequest: null,
      retryStrategy: () => null // Fail fast for initial health validation
    });

    try {
      const pong = await probe.ping();
      if (pong !== 'PONG') {
        throw new Error(`Unexpected Redis ping response: ${pong}`);
      }
      console.log(`✅ [BullMQ] Verified Redis on ${this.redisHost}:${this.redisPort} (Worker Concurrency: 1)`);
    } catch (err: any) {
      throw new Error(
        `[CRITICAL STARTUP ERROR] QUEUE_DRIVER="bullmq" requires an active Redis server at ${this.redisHost}:${this.redisPort}, ` +
        `but Redis connection failed: ${err.message}. ` +
        `Please start Redis (e.g. docker run -p 6379:6379 redis or Memurai) or explicitly configure QUEUE_DRIVER=memory in .env.`
      );
    } finally {
      try { await probe.quit(); } catch {}
    }
  }

  private updateJobState(jobId: string, patch: Partial<GpuJobStatusResponse>) {
    const current = this.jobStatuses.get(jobId);
    if (current) {
      this.jobStatuses.set(jobId, { ...current, ...patch });
    }
  }

  public async addJob(data: GpuJobData): Promise<{ jobId: string; queuePosition: number }> {
    let resolver!: (val: any) => void;
    let rejecter!: (err: any) => void;
    const promise = new Promise<any>((res, rej) => {
      resolver = res;
      rejecter = rej;
    });
    // Prevent unhandled promise rejection if caller relies on polling instead of waitForJobResult
    promise.catch(() => {});
    this.jobDeferreds.set(data.jobId, { resolve: resolver, reject: rejecter, promise });

    await this.queue.add(data.jobType.toLowerCase(), data, {
      jobId: data.jobId,
      removeOnComplete: true,
      removeOnFail: false
    });

    const waitingCount = await this.queue.getWaitingCount();
    const queuePosition = waitingCount;

    const initialStatus: GpuJobStatusResponse = {
      jobId: data.jobId,
      dreamId: data.dreamId,
      jobType: data.jobType,
      sceneNumber: data.sceneNumber,
      status: 'queued',
      queuePosition,
      progress: 0,
      currentScene: data.sceneNumber || 1,
      totalScenes: 1,
      stageLabel: `Queued (Position #${queuePosition})`
    };
    this.jobStatuses.set(data.jobId, initialStatus);

    return { jobId: data.jobId, queuePosition };
  }

  public async waitForJobResult<T = any>(jobId: string): Promise<T> {
    const deferred = this.jobDeferreds.get(jobId);
    if (deferred) {
      return deferred.promise as Promise<T>;
    }
    const status = this.jobStatuses.get(jobId);
    if (status?.status === 'completed') {
      return status.result as T;
    }
    if (status?.status === 'failed') {
      throw new Error(status.error || 'Job failed');
    }
    throw new Error(`Job ${jobId} not found in deferred map`);
  }

  public async getJobStatus(jobId: string): Promise<GpuJobStatusResponse | null> {
    const cached = this.jobStatuses.get(jobId);
    if (!cached) return null;

    if (cached.status === 'queued') {
      const job = await this.queue.getJob(jobId);
      if (job) {
        const state = await job.getState();
        if (state === 'active') {
          cached.status = 'rendering';
          cached.queuePosition = 0;
        }
      }
    }

    return cached;
  }

  public async getQueueStats() {
    const waiting = await this.queue.getWaitingCount();
    const active = await this.queue.getActiveCount();
    return {
      waiting,
      active,
      concurrency: 1,
      driver: this.driver
    };
  }

  public async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
    await this.redisClient.quit();
  }
}

/**
 * In-Memory FIFO Queue (Default development driver)
 * Concurrency: 1 (Strictly processes jobs sequentially on GPU)
 */
export class MemoryDreamQueue implements IDreamQueue {
  public driver: QueueDriverType = 'memory';
  private waitingQueue: GpuJobData[] = [];
  private activeJob: GpuJobData | null = null;
  private jobStatuses = new Map<string, GpuJobStatusResponse>();
  private jobDeferreds = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void; promise: Promise<any> }>();
  private isProcessing = false;

  constructor(private processor: JobProcessor) {}

  public async addJob(data: GpuJobData): Promise<{ jobId: string; queuePosition: number }> {
    this.waitingQueue.push(data);
    const queuePosition = this.waitingQueue.length;

    let resolver!: (val: any) => void;
    let rejecter!: (err: any) => void;
    const promise = new Promise<any>((res, rej) => {
      resolver = res;
      rejecter = rej;
    });
    // Prevent unhandled promise rejection if caller relies on polling instead of waitForJobResult
    promise.catch(() => {});
    this.jobDeferreds.set(data.jobId, { resolve: resolver, reject: rejecter, promise });

    const initialStatus: GpuJobStatusResponse = {
      jobId: data.jobId,
      dreamId: data.dreamId,
      jobType: data.jobType,
      sceneNumber: data.sceneNumber,
      status: 'queued',
      queuePosition,
      progress: 0,
      currentScene: data.sceneNumber || 1,
      totalScenes: 1,
      stageLabel: `Queued in GPU Queue (Position #${queuePosition})`
    };
    this.jobStatuses.set(data.jobId, initialStatus);

    // Trigger sequential processor loop in background
    this.processNextJob();

    return { jobId: data.jobId, queuePosition };
  }

  public async waitForJobResult<T = any>(jobId: string): Promise<T> {
    const deferred = this.jobDeferreds.get(jobId);
    if (deferred) {
      return deferred.promise as Promise<T>;
    }
    const status = this.jobStatuses.get(jobId);
    if (status?.status === 'completed') {
      return status.result as T;
    }
    if (status?.status === 'failed') {
      throw new Error(status.error || 'Job failed');
    }
    throw new Error(`Job ${jobId} not found in deferred map`);
  }

  private async processNextJob(): Promise<void> {
    if (this.isProcessing || this.waitingQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const jobData = this.waitingQueue.shift()!;
    this.activeJob = jobData;

    // Recalculate positions for remaining queued jobs
    this.updateWaitingPositions();

    const isKeyframes = jobData.jobType === 'KEYFRAMES';
    const isStitch = jobData.jobType === 'STITCH';
    const scenePrefix = jobData.sceneNumber ? `Scene #${jobData.sceneNumber}` : 'Scene';
    const status = this.jobStatuses.get(jobData.jobId);
    if (status) {
      status.status = 'rendering';
      status.queuePosition = 0;
      status.currentScene = jobData.sceneNumber || 1;
      if (isKeyframes) {
        status.stageLabel = `Generating Keyframe Visions on GPU (${scenePrefix})`;
      } else if (isStitch) {
        status.stageLabel = `FFmpeg Multi-Scene Stitching`;
      } else {
        status.stageLabel = `GPU Video Synthesis Started (${scenePrefix})`;
      }
    }

    const deferred = this.jobDeferreds.get(jobData.jobId);

    try {
      console.log(`🎬 [MemoryQueue] Processing ${jobData.jobType} job ${jobData.jobId} for dream ${jobData.dreamId} (Concurrency: 1)`);
      const result = await this.processor(jobData, (prog) => {
        const cur = this.jobStatuses.get(jobData.jobId);
        if (cur) {
          cur.progress = prog.percent;
          cur.currentScene = prog.currentScene || cur.currentScene;
          cur.totalScenes = prog.totalScenes || cur.totalScenes;
          cur.stageLabel = prog.stageLabel || prog.detail;
        }
      });

      const finished = this.jobStatuses.get(jobData.jobId);
      if (finished) {
        finished.status = 'completed';
        finished.progress = 100;
        if (isKeyframes) {
          finished.keyframes = result as KeyframeOption[];
        } else {
          finished.videoUrl = (result as DreamVideoResult).videoUrl;
        }
        finished.result = result;
      }
      deferred?.resolve(result);
    } catch (err: any) {
      console.error(`💥 [MemoryQueue] Job ${jobData.jobId} (${jobData.jobType}) failed:`, err);
      const failed = this.jobStatuses.get(jobData.jobId);
      if (failed) {
        failed.status = 'failed';
        failed.error = err.message;
      }
      deferred?.reject(err);
    } finally {
      this.jobDeferreds.delete(jobData.jobId);
      this.activeJob = null;
      this.isProcessing = false;
      // Continue next job in FIFO queue
      this.processNextJob();
    }
  }

  private updateWaitingPositions() {
    for (let i = 0; i < this.waitingQueue.length; i++) {
      const item = this.waitingQueue[i];
      const s = this.jobStatuses.get(item.jobId);
      if (s) {
        s.queuePosition = i + 1;
        s.stageLabel = `Queued in GPU Queue (Position #${i + 1})`;
      }
    }
  }

  public async getJobStatus(jobId: string): Promise<GpuJobStatusResponse | null> {
    return this.jobStatuses.get(jobId) || null;
  }

  public async getQueueStats() {
    return {
      waiting: this.waitingQueue.length,
      active: this.activeJob ? 1 : 0,
      concurrency: 1,
      driver: this.driver
    };
  }

  public async close(): Promise<void> {
    this.waitingQueue = [];
    this.activeJob = null;
  }
}

/**
 * Strict Queue Factory
 * Resolves QUEUE_DRIVER explicitly without silent fallback
 */
export async function createDreamQueue(processor: JobProcessor): Promise<IDreamQueue> {
  const driver = (process.env.QUEUE_DRIVER || 'memory').toLowerCase().trim() as QueueDriverType;

  if (driver === 'bullmq') {
    const host = process.env.REDIS_HOST || '127.0.0.1';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const password = process.env.REDIS_PASSWORD || undefined;

    console.log(`📦 [DreamQueue] Initializing BullMQ with Redis at ${host}:${port}...`);
    const queue = new BullMQDreamQueue(host, port, password, processor);
    await queue.initialize(); // Throws immediately if Redis is unreachable on boot
    return queue;
  }

  if (driver === 'memory') {
    console.log(`📦 [DreamQueue] Initializing In-Memory FIFO Queue (QUEUE_DRIVER=memory, Concurrency: 1)`);
    return new MemoryDreamQueue(processor);
  }

  throw new Error(
    `[CRITICAL STARTUP ERROR] Unknown QUEUE_DRIVER="${driver}". ` +
    `Supported queue drivers: "bullmq", "memory". Silent fallback has been disabled.`
  );
}
