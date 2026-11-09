declare module 'ffmpeg-static' {
  const ffmpegPath: string;
  export default ffmpegPath;
}

declare module 'ffprobe-static' {
  interface FfprobeStatic {
    path: string;
  }
  const ffprobe: FfprobeStatic;
  export default ffprobe;
}
