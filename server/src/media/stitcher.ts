import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

/**
 * Measure exact duration of a video file in seconds using ffprobe.
 * Never relies on hardcoded or assumed duration numbers.
 */
export async function getVideoDuration(videoPath: string): Promise<number> {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found for ffprobe inspection: ${videoPath}`);
  }

  const ffprobePath = (ffprobe as any).path || ffprobe;
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath
  ]);

  const duration = parseFloat(stdout.trim());
  if (isNaN(duration) || duration <= 0) {
    throw new Error(`Invalid duration measured by ffprobe for ${videoPath}: ${stdout}`);
  }

  return duration;
}

export interface StitchResult {
  durationSeconds: number;
  outputPath: string;
  sceneCount: number;
  isStitched: boolean;
}

/**
 * Multi-Scene Video Stitcher with Dynamic FFmpeg xfade Crossfade
 * - Single scene: No stitching performed; returns the single scene directly.
 * - Multi-scene: Dynamically measures clip durations with ffprobe, computes exact xfade offsets,
 *   and renders a seamless crossfade transition between scenes.
 */
export async function stitchSceneVideos(
  inputVideoPaths: string[],
  outputPath: string,
  configuredTransitionSec = 0.3
): Promise<StitchResult> {
  if (inputVideoPaths.length === 0) {
    throw new Error('stitchSceneVideos requires at least one input video path.');
  }

  // 1. Single Scene Bypass (Rule: "Tek sahnede birleştirme yapılmasın")
  if (inputVideoPaths.length === 1) {
    const singlePath = inputVideoPaths[0];
    const duration = await getVideoDuration(singlePath);
    
    // Copy to target output if paths differ
    if (path.resolve(singlePath) !== path.resolve(outputPath)) {
      fs.copyFileSync(singlePath, outputPath);
    }

    return {
      durationSeconds: duration,
      outputPath,
      sceneCount: 1,
      isStitched: false
    };
  }

  // 2. Multi-Scene: Measure exact durations of each clip
  const ffmpegPath = (ffmpeg as any).path || ffmpeg;
  const durations: number[] = [];
  for (const videoPath of inputVideoPaths) {
    const dur = await getVideoDuration(videoPath);
    durations.push(dur);
  }

  // Ensure transition duration is safe (must be shorter than half the shortest clip)
  const minClipDuration = Math.min(...durations);
  const transitionSec = Math.min(configuredTransitionSec, minClipDuration * 0.45);

  console.log(`🎬 [FFmpegStitcher] Stitching ${inputVideoPaths.length} scenes. Clip durations: [${durations.map(d => d.toFixed(2)).join(', ')}]s, Transition: ${transitionSec.toFixed(2)}s`);

  // 3. Build dynamic xfade filtergraph
  // For N inputs:
  // Offset 0 = Duration[0] - T
  // Offset 1 = (Duration[0] + Duration[1] - T) - T
  // Offset k = CumulativeDuration(0..k) - (k * T) - T
  const filterParts: string[] = [];
  let cumDuration = durations[0];

  for (let i = 0; i < inputVideoPaths.length - 1; i++) {
    const offset = cumDuration - transitionSec;
    const inputA = i === 0 ? '[0:v]' : `[v${i}]`;
    const inputB = `[${i + 1}:v]`;
    const outputTag = i === inputVideoPaths.length - 2 ? '[vout]' : `[v${i + 1}]`;

    filterParts.push(
      `${inputA}${inputB}xfade=transition=fade:duration=${transitionSec.toFixed(3)}:offset=${offset.toFixed(3)}${outputTag}`
    );

    cumDuration = cumDuration + durations[i + 1] - transitionSec;
  }

  const filterComplex = filterParts.join(';');

  const args: string[] = ['-y'];
  for (const videoPath of inputVideoPaths) {
    args.push('-i', videoPath);
  }
  args.push(
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-c:v', 'libx264',
    '-crf', '16',
    '-preset', 'slow',
    '-pix_fmt', 'yuv420p',
    outputPath
  );

  console.log(`🎬 [FFmpegStitcher] Executing FFmpeg command with filter_complex: ${filterComplex}`);
  await execFileAsync(ffmpegPath, args);

  // Measure final verified duration of stitched output
  const finalDuration = await getVideoDuration(outputPath);
  console.log(`✅ [FFmpegStitcher] Seamless video stitched: ${finalDuration.toFixed(2)}s -> ${outputPath}`);

  return {
    durationSeconds: finalDuration,
    outputPath,
    sceneCount: inputVideoPaths.length,
    isStitched: true
  };
}
