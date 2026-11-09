import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { 
  QueueDriverType, 
  VideoJobData, 
  VideoJobStatusResponse, 
  DreamVideoResult,
  DreamProgressEvent 
} from '../types/index.js';

export type JobProcessor = (
  jobData: VideoJobData, 
  onProgress: (event: DreamProgressEvent) => void
) => Promise<DreamVideoResult>;

export interface IDreamQueue {
  driver: QueueDriverType;
  addJob(data: VideoJobData): Promise<{ jobId: string; queuePosition: number }>;
  getJobStatus(jobId: string): Promise<VideoJobStatusResponse | null>;
  getQueueStats(): Promise<{ waiting: number; active: number; concurrency: number; driver: QueueDriverType }>;
  close(): Promise<void>;
}

/**
 * BullMQ Production Queue (Requires active Redis)
 * Strictly throws if Redis is unreachable when QUEUE_DRIVER=bullmq
 */
export class BullMQDreamQueue implements IDreamQueue {
  public driver: QueueDriverType = 'bullmq';
  private queue: Queue;
  private worker: Worker;
  private redisClient: Redis;
  private jobStatuses = new Map<string, VideoJobStatusResponse>();

  constructor(
    private redisHost: string,
    private redisPort: number,
    private redisPassword: string | undefined,
    processor: JobProcessor
  ) {
    this.redisClient = new Redis({
      host: redisHost,
      port: redisPort,
      password: redisPassword || undefined,
      maxRetriesPerRequest: null,
      retryStrategy: () => null // Fail fast if unreachable
    });

    this.queue = new Queue('dream_video_jobs', {
      connection: this.redisClient
    });

    this.worker = new Worker(
      'dream_video_jobs',
      async (job: Job<VideoJobData>) => {
        console.log(`🎬 [BullMQ] Worker started processing video job ${job.data.jobId} for dream ${job.data.dreamId}`);
        this.updateJobState(job.data.jobId, {
          status: 'rendering',
          queuePosition: 0,
          stageLabel: 'GPU Synthesis Started'
        });

        const result = await processor(job.data, (prog) => {
          this.updateJobState(job.data.jobId, {
            progress: prog.percent,
            currentScene: prog.currentScene || 1,
            totalScenes: prog.totalScenes || 1,
            stageLabel: prog.stageLabel || prog.detail
          });
          job.updateProgress(prog.percent).catch(() => {});
        });

        this.updateJobState(job.data.jobId, {
          status: 'completed',
          progress: 100,
          videoUrl: result.videoUrl,
          result
        });

        return result;
      },
      {
        connection: this.redisClient,
        concurrency: 1 // Strict WAN 2.2 GPU concurrency guard: exactly 1 video rendering at a time
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
    try {
      const pong = await this.redisClient.ping();
      if (pong !== 'PONG') {
        throw new Error(`Unexpected Redis ping response: ${pong}`);
      }
      console.log(`✅ [BullMQ] Connected to Redis on ${this.redisHost}:${this.redisPort} (Worker Concurrency: 1)`);
    } catch (err: any) {
      throw new Error(
        `[CRITICAL STARTUP ERROR] QUEUE_DRIVER="bullmq" requires an active Redis server at ${this.redisHost}:${this.redisPort}, ` +
        `but Redis connection failed: ${err.message}. ` +
        `Please start Redis (e.g. docker run -p 6379:6379 redis or Memurai) or explicitly configure QUEUE_DRIVER=memory in .env.`
      );
    }
  }

  private updateJobState(jobId: string, patch: Partial<VideoJobStatusResponse>) {
    const current = this.jobStatuses.get(jobId);
    if (current) {
      this.jobStatuses.set(jobId, { ...current, ...patch });
    }
  }

  public async addJob(data: VideoJobData): Promise<{ jobId: string; queuePosition: number }> {
    const job = await this.queue.add('generate_video', data, {
      jobId: data.jobId,
      removeOnComplete: true,
      removeOnFail: false
    });

    const waitingCount = await this.queue.getWaitingCount();
    const queuePosition = waitingCount;

    const initialStatus: VideoJobStatusResponse = {
      jobId: data.jobId,
      dreamId: data.dreamId,
      status: 'queued',
      queuePosition,
      progress: 0,
      currentScene: 1,
      totalScenes: 1,
      stageLabel: `Queued (Position #${queuePosition})`
    };
    this.jobStatuses.set(data.jobId, initialStatus);

    return { jobId: data.jobId, queuePosition };
  }

  public async getJobStatus(jobId: string): Promise<VideoJobStatusResponse | null> {
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
 * In-Memory FIFO Queue (Explicitly chosen development driver)
 * Concurrency: 1 (Strictly processes jobs sequentially)
 */
export class MemoryDreamQueue implements IDreamQueue {
  public driver: QueueDriverType = 'memory';
  private waitingQueue: VideoJobData[] = [];
  private activeJob: VideoJobData | null = null;
  private jobStatuses = new Map<string, VideoJobStatusResponse>();
  private isProcessing = false;

  constructor(private processor: JobProcessor) {}

  public async addJob(data: VideoJobData): Promise<{ jobId: string; queuePosition: number }> {
    this.waitingQueue.push(data);
    const queuePosition = this.waitingQueue.length;

    const initialStatus: VideoJobStatusResponse = {
      jobId: data.jobId,
      dreamId: data.dreamId,
      status: 'queued',
      queuePosition,
      progress: 0,
      currentScene: 1,
      totalScenes: 1,
      stageLabel: `Queued in Memory (Position #${queuePosition})`
    };
    this.jobStatuses.set(data.jobId, initialStatus);

    // Trigger sequential processor loop in background
    this.processNextJob();

    return { jobId: data.jobId, queuePosition };
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

    const status = this.jobStatuses.get(jobData.jobId);
    if (status) {
      status.status = 'rendering';
      status.queuePosition = 0;
      status.stageLabel = 'GPU Synthesis Started';
    }

    try {
      console.log(`🎬 [MemoryQueue] Processing video job ${jobData.jobId} for dream ${jobData.dreamId} (Concurrency: 1)`);
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
        finished.videoUrl = result.videoUrl;
        finished.result = result;
      }
    } catch (err: any) {
      console.error(`💥 [MemoryQueue] Job ${jobData.jobId} failed:`, err);
      const failed = this.jobStatuses.get(jobData.jobId);
      if (failed) {
        failed.status = 'failed';
        failed.error = err.message;
      }
    } finally {
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
        s.stageLabel = `Queued in Memory (Position #${i + 1})`;
      }
    }
  }

  public async getJobStatus(jobId: string): Promise<VideoJobStatusResponse | null> {
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
    await queue.initialize(); // Throws immediately if Redis is unreachable
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
