export interface AudioSettings {
  muted: boolean;
  volume: number; // 0.0 to 1.0
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  muted: false,
  volume: 0.8
};
