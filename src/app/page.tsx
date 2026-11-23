'use client';

import { useEffect, useRef, useState } from 'react';
import SingingPortrait from '@/components/SingingPortrait';

import { detectPitch, extractPitchTrack, insufficientSingingEvidence, PITCH_HOP_SECONDS,
  PITCH_WINDOW_SECONDS, type PitchFrame } from '@/lib/singing-evidence';
import { getLivePitchDisplay, getLivePitchRange, livePitchY, LIVE_PITCH_STATUS_TEXT } from '@/lib/singing-live-pitch';
import { buildRecordedFeedback } from '@/lib/recorded-feedback';
import { SINGING_PRACTICE_OCTAVE_SHIFTS, SINGING_PRACTICE_TOLERANCE } from '@/lib/singing-practice-octave';
import { getSingingPracticeReward } from '@/lib/singing-practice-rewards';

const SCROLL_SPEED = 100;
const RECORDING_LEAD_SECONDS = 0.1;
const OCTAVE_GUIDE_HINT = '同八度、高八度或低八度都可命中。练唱时，浅色线是八度参考线。';

// ================= 类型定义 =================
interface MelodyPoint {
  time: number;
  midi: number;
  vol: number;
}

interface Student {
  name: string;
}

interface ScoreComments {
  overall: string; // 总评（称号评语 + 实时数据 + 晋升提示）
  pitch: string;
  rhythm: string;
  emotion: string;
}

// 乐句级别的得分
interface PhraseScore {
  id: number;
  startTime: number;
  endTime: number;
  pitch: number | null;
  rhythm: number | null;
  emotion: number | null;
}

// 学生完整评分数据（用于分享和恢复）
interface StudentScoreData {
  name: string;
  total: number | null;
  version?: string;
  portraitReference?: MelodyPoint[];
  pitch: number | null;
  rhythm: number | null;
  emotion: number | null;
  rank?: string;
  rankColor: string;
  rankTitle?: string; // 荣誉称号（旧分享数据可能没有）
  comments: ScoreComments;
  phraseScores: PhraseScore[];
  audioUrl?: string; // 录音文件URL（分享后才有）
  sampleData?: SampleData[]; // 采样数据（用于演唱画像）
}

// 采样点数据（用于乐句分析和演唱画像）
interface SampleData {
  time: number;
  volume: number;
  hasPitch: boolean;
  isHit: boolean;
  tone?: 'hit' | 'miss' | 'pending';
  pitchDiff?: number;
  midi?: number; // 用户的实际 MIDI 值（用于演唱画像）
}

interface AppData {
  ctx: AudioContext | null;
  analyser: AnalyserNode | null;
  refBuffer: AudioBuffer | null;
  accBuffer: AudioBuffer | null;
  melodyData: MelodyPoint[];
  isPlaying: boolean;
  startTime: number;
  refTrack: PitchFrame[];
  busy: boolean;
  currentSource: AudioBufferSourceNode | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  students: Student[];
}

const DIMENSIONS = [
  { key: 'pitch', label: '音准', color: '#30d158' },
  { key: 'rhythm', label: '节奏', color: '#0a84ff' },
  { key: 'emotion', label: '情绪', color: '#ffd60a' },
] as const;

function renderStudentCard(score: StudentScoreData, key: number | string, audioUrl?: string) {
  return (
    <div key={key} className="student-card" style={{ borderLeftColor: score.rankColor }}>
      <div className="card-top">
        <div className="stu-name">
          {score.name} {score.rank && <span className="rank-badge" style={{ background: score.rankColor }}>{score.rank}</span>}
          {score.rankTitle && <span className="rank-title" style={{ color: score.rankColor }}>{score.rankTitle}</span>}
        </div>
        {score.total != null && (
          <div className="stu-total" style={{ color: score.rankColor }}>
            {score.version?.endsWith('-practice') && <span className="mr-1 text-xs">练唱分</span>}{score.total}
          </div>
        )}
      </div>
      <div className="dim-bars">
        {DIMENSIONS.map(dimension => {
          const value = score[dimension.key];
          return (
            <div className="dim-row" key={dimension.key}>
              <span className="dim-label">{dimension.key === 'emotion' && score.version ? '强弱' : dimension.label}</span>
              <div className="dim-track">{value != null && <div className="dim-fill" style={{ width: `${value}%`, background: dimension.color }} />}</div>
              <span className="dim-score">{value ?? '待复核'}</span>
            </div>
          );
        })}
      </div>
      <div className="pro-comment">
        {score.comments.overall && <div className="comment-item"><span>{score.comments.overall}</span></div>}
        {DIMENSIONS.map(dimension => (
          <div key={dimension.key} className="comment-item">
            <span className="c-label">{dimension.key === 'emotion' && score.version ? '强弱处理' : dimension.label}</span>
            <span>{score.comments[dimension.key]}</span>
          </div>
        ))}
      </div>
      {score.phraseScores?.length > 0 && (
        <div className="phrase-details mt-3">
          <div className="phrase-details-header">乐句参考 · {score.phraseScores.length} 个片段</div>
          <div className="phrase-details-content">
            {score.phraseScores.map(phrase => (
              <div key={phrase.id} className="phrase-item">
                <div className="phrase-time-badge">{phrase.startTime.toFixed(1)}–{phrase.endTime.toFixed(1)} 秒</div>
                <div className="phrase-info">
                  <div className="phrase-scores">
                    {DIMENSIONS.map(dimension => (
                      <div key={dimension.key} className="phrase-score-item">
                        <span className="phrase-label">{dimension.key === 'emotion' && score.version ? '强弱' : dimension.label}</span>
                        <span>{phrase[dimension.key] ?? '待复核'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {audioUrl && <audio controls src={audioUrl} />}
    </div>
  );
}

export default function Home() {
  // Refs (用于可变数据，避免闭包问题)
  const desktopCanvasRef = useRef<HTMLCanvasElement>(null);
  const mobileCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileRefRef = useRef<HTMLInputElement>(null);
  const fileAccRef = useRef<HTMLInputElement>(null);
  const fileScoreRef = useRef<HTMLInputElement>(null);
  const audioLoadingRef = useRef(false);
  const appDataRef = useRef<AppData>({
    ctx: null,
    analyser: null,
    refBuffer: null,
    accBuffer: null,
    melodyData: [],
    isPlaying: false,
    startTime: 0,
    refTrack: [],
    busy: false,
    currentSource: null,
    recorder: null,
    chunks: [],
    students: []
  });

  // State (用于触发重新渲染)
  const [realtimeScore, setRealtimeScore] = useState('--');
  const [realtimeStatus, setRealtimeStatus] = useState('Ready');
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState('Processing...');
  const [studentCards, setStudentCards] = useState<React.ReactElement[]>([]);
  const [studentScoreData, setStudentScoreData] = useState<StudentScoreData[]>([]); // 存储评分数据用于分享
  const [sessionBusy, setSessionBusy] = useState(false);
  const [pairConfirmed, setPairConfirmed] = useState(false);
  const [accLoaded, setAccLoaded] = useState(false); // 伴奏是否已加载（用于触发UI更新）
  const [scoreImage, setScoreImage] = useState<string | null>(null);
  const [updateCounter, setUpdateCounter] = useState(0); // 用于触发 UI 更新
  const [shareLoading, setShareLoading] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [portraitStudentIndex, setPortraitStudentIndex] = useState(0); // 演唱画像显示的学生索引

  // ================= 1. 工具函数 =================
  // 安全解析JSON响应
  const safeParseJSON = async (response: Response): Promise<{ success: boolean; data?: any; error?: string }> => {
    try {
      const text = await response.text();
      if (!text) {
        return { success: false, error: '服务器返回空响应' };
      }
      try {
        const json = JSON.parse(text);
        return { success: true, data: json };
      } catch {
        console.error('JSON parse error, response text:', text.substring(0, 200));
        return { success: false, error: `服务器返回非JSON响应: ${text.substring(0, 100)}` };
      }
    } catch (error) {
      return { success: false, error: '读取响应失败' };
    }
  };

  const showLoading = (show: boolean, text: string = '处理中…') => {
    setLoading(show);
    setLoadingText(text);
  };

  const setReference = (buffer: AudioBuffer) => {
    const data = appDataRef.current;
    data.refBuffer = buffer;
    data.refTrack = extractPitchTrack({ samples: buffer.getChannelData(0), sampleRate: buffer.sampleRate });
    data.melodyData = data.refTrack.flatMap(frame =>
      frame.midi === null ? [] : [{ time: frame.time, midi: frame.midi, vol: frame.rms }]);
  };

  // ================= 3. 文件上传处理 =================
  const loadFile = async (file: File | null, type: 'ref' | 'acc') => {
    if (!file || appDataRef.current.busy || audioLoadingRef.current) return;
    audioLoadingRef.current = true;

    showLoading(true, '正在分析音频...');
    const ctx = appDataRef.current.ctx || new (window.AudioContext || (window as any).webkitAudioContext)();

    try {
      const ab = await file.arrayBuffer();
      const buffer = await ctx.decodeAudioData(ab);

      setPairConfirmed(false);
      if (type === 'ref') {
        appDataRef.current.ctx = ctx;
        setReference(buffer);
        setUpdateCounter(prev => prev + 1);
        // 上传干声后启动预览模式
        setTimeout(() => drawLoop(true), 100);
      } else {
        appDataRef.current.ctx = ctx;
        appDataRef.current.accBuffer = buffer;
        setAccLoaded(true); // 标记伴奏已加载
        setUpdateCounter(prev => prev + 1);
      }
    } catch (e) {
      console.error('文件加载失败:', e);
      alert('文件加载失败');
    } finally {
      audioLoadingRef.current = false;
      showLoading(false);
    }
  };

  const handleRefUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    loadFile(file, 'ref');
    if (e.target) e.target.value = '';
  };

  const handleAccUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    loadFile(file, 'acc');
    if (e.target) e.target.value = '';
  };

  const handleScoreUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      setScoreImage(evt.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  // ================= 4. 开始/结束评测 =================
  const startSession = async () => {
    const data = appDataRef.current;
    const { ctx, refBuffer, accBuffer } = data;
    if (audioLoadingRef.current || data.busy || data.students.length >= 4 || !ctx || !refBuffer || (accBuffer && !pairConfirmed)) return;

    data.busy = true;
    setSessionBusy(true);
    setRealtimeStatus('正在准备录音…');
    let stream: MediaStream | undefined;
    let micSource: MediaStreamAudioSourceNode | undefined;
    try {
      await ctx.resume();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false },
      });
      micSource = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2 ** Math.ceil(Math.log2(ctx.sampleRate * PITCH_WINDOW_SECONDS));
      micSource.connect(analyser);

      const activeStream = stream;
      const input = micSource;
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        activeStream.getTracks().forEach(track => track.stop());
        input.disconnect();
        data.analyser = null;
        data.recorder = null;
        data.chunks = chunks;
        const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type });
        try {
          setRealtimeStatus('正在分析录音…');
          if (!blob.size) {
            setRealtimeStatus('未录到声音，请检查麦克风后重试');
            return;
          }
          let feedback: ReturnType<typeof buildRecordedFeedback>;
          try {
            const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
            feedback = buildRecordedFeedback(data.refTrack, audio, RECORDING_LEAD_SECONDS);
          } catch {
            const result = insufficientSingingEvidence('recording_analysis_failed');
            result.comments = { ...result.comments,
              pitch: '录音暂无法分析，请先试听。', rhythm: '录音暂无法分析，请先试听。',
              emotion: '录音暂无法分析，请先试听。' };
            feedback = { result, phraseScores: [], sampleData: [] };
          }
          const { result, phraseScores, sampleData } = feedback;
          addStudentCard(result, blob, phraseScores, sampleData);
          setRealtimeStatus('本次反馈已生成');
        } finally {
          data.busy = false;
          setSessionBusy(false);
        }
      };
      const source = ctx.createBufferSource();
      source.buffer = accBuffer || refBuffer;
      source.connect(ctx.destination);
      data.currentSource = source;
      data.recorder = recorder;
      data.analyser = analyser;

      recorder.start();
      data.startTime = ctx.currentTime + RECORDING_LEAD_SECONDS;
      source.start(data.startTime);
      source.onended = stopSession;
      data.isPlaying = true;
      setRealtimeStatus('正在录音');
      setRealtimeScore('--');
      drawLoop();
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      micSource?.disconnect();
      data.currentSource?.disconnect();
      data.currentSource = null;
      data.recorder = null;
      data.analyser = null;
      data.isPlaying = false;
      data.busy = false;
      setSessionBusy(false);
      setRealtimeStatus('无法启动录音，请检查麦克风权限');
      console.error(error);
    }
  };

  const stopSession = () => {
    const data = appDataRef.current;
    if (!data.isPlaying) return;
    data.isPlaying = false;
    const source = data.currentSource;
    data.currentSource = null;
    if (source) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    if (data.recorder?.state === 'recording') data.recorder.stop();
    setRealtimeScore('--');
    setUpdateCounter(prev => prev + 1);
  };

  // ================= 5. 实时绘制 =================
  const drawLoop = (preview = false) => {
    const data = appDataRef.current;

    // 预览模式：只显示旋律线，不停止
    // 实时模式：正在播放时才继续
    if (preview ? data.isPlaying : !data.isPlaying) return;

    // 根据屏幕尺寸选择正确的 canvas
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
    const canvas = isMobile ? mobileCanvasRef.current : desktopCanvasRef.current;
    if (!canvas) return;

    // 确保 canvas 尺寸正确
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
      }
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    // 计算当前时间
    // 预览模式：now = 0（静态显示）
    // 实时模式：now = ctx.currentTime - startTime
    let now = 0;
    if (!preview && data.ctx) {
      now = data.ctx.currentTime - data.startTime;
    }

    // 清空画布
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    // 绘制波形（仅实时模式）
    if (!preview && data.analyser) {
      const wave = new Uint8Array(data.analyser.frequencyBinCount);
      data.analyser.getByteTimeDomainData(wave);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(10, 132, 255, 0.3)';
      ctx.beginPath();
      const slice = w / wave.length;
      let x = 0;
      for (let i = 0; i < wave.length; i += 4) {
        const v = wave[i] / 128.0;
        const y = v * h * 0.8;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += slice * 4;
      }
      ctx.stroke();
    }

    const centerX = w / 3;
    const sampleRate = data.ctx?.sampleRate ?? 48000;
    const windowSize = Math.round(sampleRate * PITCH_WINDOW_SECONDS);
    const slot = Math.floor((now - windowSize / sampleRate / 2) / PITCH_HOP_SECONDS);
    const reference = data.refTrack[slot];
    let marker: ReturnType<typeof getLivePitchDisplay>['marker'] = null;
    if (!preview && data.analyser && slot >= 0) {
      const buffer = new Float32Array(data.analyser.fftSize);
      data.analyser.getFloatTimeDomainData(buffer);
      const detected = detectPitch(buffer.subarray(-windowSize), sampleRate);
      const view = getLivePitchDisplay(detected, reference);
      marker = view.marker;
      setRealtimeScore(view.status === 'matched' ? '✨' : view.status === 'deviated' ? '↕' : '—');
      setRealtimeStatus(LIVE_PITCH_STATUS_TEXT[view.status]);
    }
    const range = getLivePitchRange(data.refTrack, marker?.midi);
    for (const point of data.melodyData) {
      const x = centerX + (point.time - now) * SCROLL_SPEED;
      if (x <= -10 || x >= w) continue;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.fillRect(x, livePitchY(point.midi, h, range) - 3, 4, 6);
      if (!preview) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.13)';
        for (const shift of SINGING_PRACTICE_OCTAVE_SHIFTS) {
          if (shift !== 0) ctx.fillRect(x, livePitchY(point.midi + shift, h, range) - 2, 4, 4);
        }
      }
    }
    if (marker) {
      ctx.beginPath();
      ctx.arc(centerX, livePitchY(marker.midi, h, range), 8, 0, Math.PI * 2);
      if (marker.tone === 'pending') {
        ctx.strokeStyle = '#ffd60a';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.fillStyle = marker.tone === 'hit' ? '#30d158' : '#ff453a';
        ctx.fill();
      }
    }

    // 绘制中心线
    ctx.beginPath();
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, h);
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([5, 5]);
    ctx.stroke();

    // 继续循环
    if (preview) {
      requestAnimationFrame(() => drawLoop(true));
    } else if (data.isPlaying) {
      requestAnimationFrame(() => drawLoop(false));
    }
  };

  const addStudentCard = (
    result: ReturnType<typeof insufficientSingingEvidence>,
    blob: Blob,
    phraseScores: PhraseScore[],
    sampleData: SampleData[],
  ) => {
    const data = appDataRef.current;
    const name = `同学 ${String.fromCharCode(65 + data.students.length)}`;
    const reward = getSingingPracticeReward(result);
    const score: StudentScoreData = {
      name, total: reward.total, pitch: result.pitch, rhythm: result.rhythm, emotion: result.emotion,
      version: result.scoringVersion,
      portraitReference: data.melodyData,
      rank: reward.total === null ? undefined : `Lv.${reward.total}`,
      rankColor: reward.color, rankTitle: reward.title ?? undefined, phraseScores, sampleData,
      comments: { ...result.comments, overall: reward.message },
    };
    const audioUrl = URL.createObjectURL(blob);
    setStudentCards(prev => [renderStudentCard(score, name, audioUrl), ...prev]);
    setStudentScoreData(prev => [score, ...prev]);
    data.students.push({ name });
    setUpdateCounter(prev => prev + 1);
  };

  const resetClassroom = () => {
    if (appDataRef.current.busy || !confirm('确定要清空记录吗？')) return;
    const data = appDataRef.current;
    data.students = [];
    setStudentCards([]);
    setStudentScoreData([]);
    setUpdateCounter(prev => prev + 1);
  };

  // ================= 分享功能 =================
  const createShareLink = async () => {
    const data = appDataRef.current;
    
    // 检查是否有可分享的内容
    if (!data.refBuffer && studentCards.length === 0) {
      alert('请先上传干声或有学生演唱记录后才能分享');
      return;
    }
    
    setShareLoading(true);
    
    try {
      const formData = new FormData();
      
      // 添加干声文件
      if (data.refBuffer) {
        // 将 AudioBuffer 转换为 Blob
        const offlineCtx = new OfflineAudioContext(
          data.refBuffer.numberOfChannels,
          data.refBuffer.length,
          data.refBuffer.sampleRate
        );
        const bufferSource = offlineCtx.createBufferSource();
        bufferSource.buffer = data.refBuffer;
        bufferSource.connect(offlineCtx.destination);
        bufferSource.start();
        
        const renderedBuffer = await offlineCtx.startRendering();
        const wavBlob = audioBufferToWav(renderedBuffer);
        formData.append('refAudio', wavBlob, 'ref_audio.wav');
      }
      
      // 添加伴奏文件
      if (data.accBuffer) {
        const offlineCtx = new OfflineAudioContext(
          data.accBuffer.numberOfChannels,
          data.accBuffer.length,
          data.accBuffer.sampleRate
        );
        const bufferSource = offlineCtx.createBufferSource();
        bufferSource.buffer = data.accBuffer;
        bufferSource.connect(offlineCtx.destination);
        bufferSource.start();
        
        const renderedBuffer = await offlineCtx.startRendering();
        const wavBlob = audioBufferToWav(renderedBuffer);
        formData.append('accAudio', wavBlob, 'acc_audio.wav');
      }
      
      // 添加乐谱图片
      if (scoreImage && scoreImage.startsWith('data:')) {
        const base64Data = scoreImage.split(',')[1];
        const mimeType = scoreImage.split(';')[0].split(':')[1];
        const byteCharacters = atob(base64Data);
        const byteArrays = [];
        
        for (let offset = 0; offset < byteCharacters.length; offset += 512) {
          const slice = byteCharacters.slice(offset, offset + 512);
          const byteNumbers = new Array(slice.length);
          for (let i = 0; i < slice.length; i++) {
            byteNumbers[i] = slice.charCodeAt(i);
          }
          const byteArray = new Uint8Array(byteNumbers);
          byteArrays.push(byteArray);
        }
        
        const blob = new Blob(byteArrays, { type: mimeType });
        formData.append('scoreImage', blob, 'score_image.png');
      }
      
      // 添加学生评分数据（从 studentCards 中提取）
      if (studentCards.length > 0) {
        const scoresData = studentCards.map((card, idx) => {
          // 简化存储，只存储基本信息
          return {
            id: idx,
            // 这里存储的是 React 元素，实际应该存储原始数据
            // 暂时存储空对象，后续可以优化
          };
        });
        formData.append('studentScores', JSON.stringify(scoresData));
      }
      
      const response = await fetch('/api/share', {
        method: 'POST',
        body: formData,
      });
      
      const result = await response.json();
      
      if (result.success) {
        setShareUrl(result.shareUrl);
        // 复制到剪贴板
        await navigator.clipboard.writeText(result.shareUrl);
        alert('分享链接已复制到剪贴板！');
      } else {
        alert('创建分享链接失败，请重试');
      }
    } catch (error) {
      console.error('Share error:', error);
      alert('分享失败，请重试');
    } finally {
      setShareLoading(false);
    }
  };

  // 将 AudioBuffer 转换为 WAV 格式
  // 将 AudioBuffer 转换为 WAV 格式（支持降采样以减小文件大小）
  const audioBufferToWav = (buffer: AudioBuffer, targetSampleRate: number = 22050): Blob => {
    // 降采样处理：降低采样率以减小文件大小
    const originalRate = buffer.sampleRate;
    const ratio = originalRate / targetSampleRate;
    const newLength = Math.floor(buffer.length / ratio);
    const numOfChan = Math.min(buffer.numberOfChannels, 1); // 强制单声道以减小文件
    const length = newLength * numOfChan * 2 + 44;
    const bufferArray = new ArrayBuffer(length);
    const view = new DataView(bufferArray);
    const channels: Float32Array[] = [];
    let sample: number;
    let offset = 0;
    let pos = 0;
    
    // 写入 WAV 头
    setUint32(view, 0x46464952, pos); pos += 4; // "RIFF"
    setUint32(view, length - 8, pos); pos += 4; // file length - 8
    setUint32(view, 0x45564157, pos); pos += 4; // "WAVE"
    setUint32(view, 0x20746d66, pos); pos += 4; // "fmt " chunk
    setUint32(view, 16, pos); pos += 4; // length = 16
    setUint16(view, 1, pos); pos += 2; // PCM (uncompressed)
    setUint16(view, numOfChan, pos); pos += 2; // number of channels
    setUint32(view, targetSampleRate, pos); pos += 4; // sample rate
    setUint32(view, targetSampleRate * 2 * numOfChan, pos); pos += 4; // avg. bytes/sec
    setUint16(view, numOfChan * 2, pos); pos += 2; // block-align
    setUint16(view, 16, pos); pos += 2; // 16-bit
    setUint32(view, 0x61746164, pos); pos += 4; // "data" chunk
    setUint32(view, length - pos - 4, pos); pos += 4;
    
    // 获取通道数据（只取第一个通道，即单声道）
    const sourceChannel = buffer.getChannelData(0);
    
    // 写入音频数据（带降采样）
    while (pos < length) {
      // 使用简单的线性插值进行降采样
      const srcIndex = Math.floor(offset * ratio);
      if (srcIndex < sourceChannel.length) {
        sample = Math.max(-1, Math.min(1, sourceChannel[srcIndex]));
        sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(pos, sample, true);
      }
      pos += 2;
      offset++;
    }
    
    return new Blob([bufferArray], { type: 'audio/wav' });
  };
  
  const setUint16 = (view: DataView, value: number, pos: number) => {
    view.setUint16(pos, value, true);
  };
  
  const setUint32 = (view: DataView, value: number, pos: number) => {
    view.setUint32(pos, value, true);
  };

  // 从分享链接加载数据
  const loadFromShare = async (shareId: string) => {
    setLoading(true);
    setLoadingText('正在加载分享数据...');
    
    try {
      const response = await fetch(`/api/share/${shareId}`);
      const result = await response.json();
      
      if (result.success && result.data) {
        const { voiceUrl, accompanimentUrl, scoreImageUrl, scores } = result.data;
        
        // 加载干声
        if (voiceUrl) {
          setLoadingText('正在加载干声...');
          const audioResponse = await fetch(voiceUrl);
          const audioBlob = await audioResponse.blob();
          const audioFile = new File([audioBlob], 'ref_audio.wav', { type: 'audio/wav' });
          await loadFile(audioFile, 'ref');
        }
        
        // 加载伴奏
        if (accompanimentUrl) {
          setLoadingText('正在加载伴奏...');
          const audioResponse = await fetch(accompanimentUrl);
          const audioBlob = await audioResponse.blob();
          const audioFile = new File([audioBlob], 'acc_audio.wav', { type: 'audio/wav' });
          await loadFile(audioFile, 'acc');
        }
        
        // 加载乐谱
        if (scoreImageUrl) {
          setScoreImage(scoreImageUrl);
        }
        
        // 恢复学生评分数据
        if (scores && scores.length > 0) {
          setLoadingText('正在恢复评分记录...');
          
          // 保存评分数据
          setStudentScoreData(scores);
          
          appDataRef.current.students = scores.map((score: StudentScoreData) => ({ name: score.name }));
          setStudentCards(scores.map((score: StudentScoreData, index: number) => renderStudentCard(score, index, score.audioUrl)));
          setUpdateCounter(prev => prev + 1);
        }
      }
    } catch (error) {
      console.error('Load share data error:', error);
      alert('加载分享数据失败');
    } finally {
      setLoading(false);
    }
  };

  // 分享课堂数据
  const handleShare = async () => {
    const data = appDataRef.current;
    const hasVoice = data.refBuffer !== null;
    const hasStudents = studentScoreData.length > 0;
    
    // 调试信息
    console.log('分享状态检查:', { 
      hasVoice, 
      hasStudents, 
      refBufferExists: !!data.refBuffer,
      accBufferExists: !!data.accBuffer,
      studentCount: studentScoreData.length 
    });
    
    if (!hasVoice && !hasStudents) {
      alert('请先上传干声或进行演唱评测。\n\n调试信息：\n- 干声状态: ' + (hasVoice ? '已上传' : '未上传') + '\n- 学生记录: ' + (hasStudents ? '有' : '无'));
      return;
    }
    
    setShareLoading(true);
    setLoading(true);
    setLoadingText('正在准备分享数据...');
    
    try {
      // 1. 上传干声文件（优先从内存中的AudioBuffer，其次从录制数据，最后从文件input）
      let voiceUrl = null;
      const refBuffer = data.refBuffer;
      
      if (refBuffer) {
        // 从AudioBuffer转换为WAV文件上传
        setLoadingText('正在上传干声...');
        const wavBlob = audioBufferToWav(refBuffer);
        
        // 检查文件大小
        const fileSizeMB = (wavBlob.size / (1024 * 1024)).toFixed(2);
        console.log('干声文件大小:', fileSizeMB, 'MB');
        
        if (wavBlob.size > 50 * 1024 * 1024) {
          alert(`干声文件太大 (${fileSizeMB}MB)，请使用较短的音频文件`);
          setLoading(false);
          setShareLoading(false);
          return;
        }
        
        const file = new File([wavBlob], 'voice.wav', { type: 'audio/wav' });
        
        const formData = new FormData();
        formData.append('file', file);
        formData.append('type', 'voice');
        
        const uploadResponse = await fetch('/api/upload', {
          method: 'POST',
          body: formData
        });
        
        const parseResult = await safeParseJSON(uploadResponse);
        if (parseResult.success && parseResult.data?.success) {
          voiceUrl = parseResult.data.url;
        } else {
          console.error('Upload voice from refBuffer failed:', parseResult.error);
        }
      } else {
        // 尝试从录制数据获取
        const chunks = appDataRef.current.chunks;
        if (chunks && chunks.length > 0) {
          setLoadingText('正在上传录制数据...');
          const blob = new Blob(chunks, { type: 'audio/webm' });
          const file = new File([blob], 'voice.webm', { type: 'audio/webm' });
          
          const formData = new FormData();
          formData.append('file', file);
          formData.append('type', 'voice');
          
          const uploadResponse = await fetch('/api/upload', {
            method: 'POST',
            body: formData
          });
          
          const parseResult = await safeParseJSON(uploadResponse);
          if (parseResult.success && parseResult.data?.success) {
            voiceUrl = parseResult.data.url;
          }
        }
        
        // 尝试从文件input获取
        if (!voiceUrl) {
          const refInput = fileRefRef.current;
          if (refInput && refInput.files && refInput.files[0]) {
            setLoadingText('正在上传干声...');
            const formData = new FormData();
            formData.append('file', refInput.files[0]);
            formData.append('type', 'voice');
            
            const uploadResponse = await fetch('/api/upload', {
              method: 'POST',
              body: formData
            });
            
            const parseResult = await safeParseJSON(uploadResponse);
            if (parseResult.success && parseResult.data?.success) {
              voiceUrl = parseResult.data.url;
            }
          }
        }
      }
      
      if (!voiceUrl) {
        alert('请先上传干声或录制演唱');
        setLoading(false);
        setShareLoading(false);
        return;
      }
      
      setLoadingText('正在上传伴奏...');
      
      // 3. 上传伴奏（优先从内存中的AudioBuffer，其次从文件input）
      let accompanimentUrl = null;
      const accBuffer = appDataRef.current.accBuffer;
      
      if (accBuffer) {
        // 从AudioBuffer转换为WAV文件上传
        const wavBlob = audioBufferToWav(accBuffer);
        
        // 检查文件大小
        const fileSizeMB = (wavBlob.size / (1024 * 1024)).toFixed(2);
        console.log('伴奏文件大小:', fileSizeMB, 'MB');
        
        if (wavBlob.size > 50 * 1024 * 1024) {
          console.warn('伴奏文件太大，跳过上传');
        } else {
          const file = new File([wavBlob], 'accompaniment.wav', { type: 'audio/wav' });
          
          const formData = new FormData();
          formData.append('file', file);
          formData.append('type', 'accompaniment');
          
          const uploadResponse = await fetch('/api/upload', {
            method: 'POST',
            body: formData
          });
          
          const parseResult = await safeParseJSON(uploadResponse);
          if (parseResult.success && parseResult.data?.success) {
            accompanimentUrl = parseResult.data.url;
          } else {
            console.error('Upload accompaniment failed:', parseResult.error);
          }
        }
      } else {
        // 尝试从文件input获取
        const accInput = fileAccRef.current;
        if (accInput && accInput.files && accInput.files[0]) {
          const formData = new FormData();
          formData.append('file', accInput.files[0]);
          formData.append('type', 'accompaniment');
          
          const uploadResponse = await fetch('/api/upload', {
            method: 'POST',
            body: formData
          });
          
          const parseResult = await safeParseJSON(uploadResponse);
          if (parseResult.success && parseResult.data?.success) {
            accompanimentUrl = parseResult.data.url;
          }
        }
      }
      
      setLoadingText('正在上传乐谱...');
      
      // 4. 上传乐谱图片（如果有）
      let scoreImageUrl = null;
      if (scoreImage) {
        // 将base64转换为文件
        const response = await fetch(scoreImage);
        const blob = await response.blob();
        const file = new File([blob], 'score.png', { type: 'image/png' });
        
        const formData = new FormData();
        formData.append('file', file);
        formData.append('type', 'score');
        
        const uploadResponse = await fetch('/api/upload', {
          method: 'POST',
          body: formData
        });
        
        const parseResult = await safeParseJSON(uploadResponse);
        if (parseResult.success && parseResult.data?.success) {
          scoreImageUrl = parseResult.data.url;
        }
      }
      
      setLoadingText('正在生成分享链接...');
      
      // 5. 保存真实的评分数据
      const scores = studentScoreData;
      
      // 6. 创建分享链接
      const shareResponse = await fetch('/api/share', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          voiceUrl,
          accompanimentUrl,
          scoreImageUrl,
          scores,
          phrases: []
        })
      });
      
      const shareParseResult = await safeParseJSON(shareResponse);
      
      if (shareParseResult.success && shareParseResult.data?.success) {
        // 使用当前域名拼接完整URL
        const fullShareUrl = `${window.location.origin}/?share=${shareParseResult.data.shareId}`;
        setShareUrl(fullShareUrl);
        // 复制到剪贴板
        try {
          await navigator.clipboard.writeText(fullShareUrl);
          alert('分享链接已复制到剪贴板！');
        } catch {
          alert(`分享链接：${fullShareUrl}`);
        }
      } else {
        const errorMsg = shareParseResult.error || shareParseResult.data?.error || '创建分享链接失败';
        console.error('Share API error:', errorMsg);
        alert(`分享失败: ${errorMsg}`);
      }
    } catch (error) {
      console.error('Share error:', error);
      alert('分享失败，请重试');
    } finally {
      setLoading(false);
      setShareLoading(false);
    }
  };

  // ================= 初始化画布 =================
  useEffect(() => {
    const initCanvas = (canvas: HTMLCanvasElement | null) => {
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
      }
    };
    initCanvas(desktopCanvasRef.current);
    initCanvas(mobileCanvasRef.current);
  }, []);

  // 检测 URL 中的分享参数并加载数据
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const shareId = urlParams.get('share');
    if (shareId) {
      loadFromShare(shareId);
    }
  }, []);

  const refBuffer = appDataRef.current.refBuffer;
  const accBuffer = appDataRef.current.accBuffer;
  const students = appDataRef.current.students;
  const portraitScore = studentScoreData[portraitStudentIndex];
  const portraitAllowsAdjacentOctaves = portraitScore?.version?.endsWith('-practice') ?? false;

  // 移动端当前激活的标签页
  const [mobileTab, setMobileTab] = useState<'main' | 'records' | 'score'>('main');

  // 演唱画像是否展开
  const [portraitExpanded, setPortraitExpanded] = useState(false);

  // 当移动端主控台可见且正在录音时，恢复drawLoop
  useEffect(() => {
    if (mobileTab === 'main' && appDataRef.current.isPlaying) {
      // 延迟一点确保canvas已挂载
      const timer = setTimeout(() => {
        drawLoop();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [mobileTab]);

  return (
    <div className="flex h-screen overflow-hidden bg-[#121214] text-[#e0e0e0]">
      {/* Loading Overlay */}
      {loading && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 backdrop-blur-sm">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-[#333] border-t-[#0a84ff]"></div>
          <div className="mt-5 text-base font-bold text-white">{loadingText}</div>
        </div>
      )}

      {/* 桌面端左侧：课堂记录（全高） */}
      <div className="hidden md:flex h-full w-[320px] shrink-0 flex-col border-r border-[#333] bg-[#18181a]">
        <div className="border-b border-[#333] bg-[#1c1c1f] px-5 py-5">
          <div className="flex items-center justify-between text-base font-bold text-white">
            <span>课堂记录</span>
            <span className="text-[#0a84ff]">{students.length} / 4</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-[15px] py-[15px]">
          {studentCards.length === 0 ? (
            <div className="mt-[50px] text-center text-[13px] text-[#555]">
              暂无记录<br />请在中间区域开始
            </div>
          ) : (
            studentCards
          )}
        </div>
        <div className="border-t border-[#333] px-[15px] py-[15px] flex flex-col gap-2">
          <button
            onClick={handleShare}
            disabled={studentScoreData.length === 0 && !refBuffer}
            className="w-full rounded-lg border-none bg-[#0a84ff] py-3 text-[14px] text-white cursor-pointer hover:bg-[#0070e0] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            分享课堂
          </button>
          <button
            onClick={resetClassroom}
            className="w-full rounded-lg border-none bg-[#333] py-3 text-[14px] text-[#aaa] cursor-pointer hover:bg-[#444] transition-colors"
          >
            重置课堂
          </button>
        </div>
      </div>

      {/* 桌面端右侧整体：测评区 + 乐谱 + 演唱画像(垂直)，短视口时允许整体滚动防止画像被压没 */}
      <div className="hidden md:flex flex-1 flex-col min-h-0 min-w-0 overflow-y-auto">
        {/* 上半水平行：测评区 + 乐谱视窗(等高，按内容高度) */}
        <div className="flex shrink-0 min-h-0">
          {/* 中间：主控台（测评区） */}
      <div className="flex flex-1 flex-col items-center overflow-y-auto min-h-0 min-w-0 p-5 border-r border-[#333] md:p-3">
        <div className="w-full max-w-[1200px] rounded-2xl bg-[#1e1e20] p-5 shadow-[0_10px_40px_rgba(0,0,0,0.4)] border border-[#333]">
          <h2 className="mb-5 flex items-center justify-between text-lg">
            <span>🎹 智能声乐评测 <span style={{ fontSize: '12px', background: '#333', padding: '2px 6px', borderRadius: '4px', color: '#aaa' }}>V9.0</span></span>
            <span className="text-base font-bold text-[#0a84ff]">
              {refBuffer ? `当前: 第 ${students.length + 1} 位同学` : '等待文件'}
            </span>
          </h2>

          <div className="mb-5 grid grid-cols-3 gap-[10px]">
            <div
              onClick={() => fileRefRef.current?.click()}
              className={`track-slot ${refBuffer ? 'loaded' : ''}`}
            >
              <span className="icon-status">{refBuffer ? '✅' : '🗣️'}</span>
              <span className="slot-label">{refBuffer ? '干声已就绪' : '1. 干声(必选)'}</span>
              <span className="slot-desc">AI分析旋律</span>
            </div>
            <div
              onClick={() => fileAccRef.current?.click()}
              className={`track-slot ${accBuffer ? 'loaded' : ''}`}
            >
              <span className="icon-status">{accBuffer ? '✅' : '🎼'}</span>
              <span className="slot-label">{accBuffer ? '伴奏已就绪' : '2. 伴奏(可选)'}</span>
              <span className="slot-desc">背景播放</span>
            </div>
            <div
              onClick={() => fileScoreRef.current?.click()}
              className={`track-slot ${scoreImage ? 'loaded' : ''}`}
            >
              <span className="icon-status">{scoreImage ? '✅' : '📄'}</span>
              <span className="slot-label">{scoreImage ? '乐谱已加载' : '3. 乐谱(可选)'}</span>
              <span className="slot-desc">右侧显示</span>
            </div>
          </div>

          <input
            ref={fileRefRef}
            type="file"
            accept="audio/*"
            onChange={handleRefUpload}
            className="hidden"
          />
          <input
            ref={fileAccRef}
            type="file"
            accept="audio/*"
            onChange={handleAccUpload}
            className="hidden"
          />
          <input
            ref={fileScoreRef}
            type="file"
            accept="image/*"
            onChange={handleScoreUpload}
            className="hidden"
          />

          <div className="relative mb-5 h-[240px] overflow-hidden rounded-xl border-2 border-[#333] bg-black">
            <canvas ref={desktopCanvasRef} className="block h-full w-full" />
            <div className="absolute right-[15px] top-[15px] text-right pointer-events-none">
              <div className="text-[32px] font-black text-[#30d158] transition-colors" id="realtimeScore">
                {realtimeScore}
              </div>
              <div className="mt-[5px] text-[14px] text-[#aaa]">{realtimeStatus}</div>
            </div>
          </div>

          {refBuffer && <p className="mb-2 text-xs text-[#aaa]">{OCTAVE_GUIDE_HINT}</p>}
          {accLoaded && (
                <label className="mb-2 flex gap-2 text-xs text-[#ccc]">
                  <input type="checkbox" checked={pairConfirmed} disabled={sessionBusy}
                    onChange={event => setPairConfirmed(event.target.checked)} />
                  已确认干声和伴奏为同一乐段、同调、同速度，且从同一位置开始
                </label>
              )}
              <div className="grid grid-cols-2 gap-[15px]">
            <button
              onClick={startSession}
              disabled={!refBuffer || students.length >= 4 || loading || sessionBusy || (accLoaded && !pairConfirmed)}
              className="btn btn-start"
            >
              🎙️ 第 {students.length + 1} 位同学 (开始)
            </button>
            <button
              onClick={stopSession}
              disabled={!appDataRef.current.isPlaying}
              className="btn btn-stop"
            >
              ⏹ 结束评测
            </button>
          </div>
        </div>
      </div>

          {/* 右侧：乐谱视窗(等高) */}
          <div className="w-[460px] shrink-0 flex flex-col bg-[#151517]">
        {/* 上半部分：乐谱视窗（填满列高，图片垂直居中展示） */}
        <div className="flex flex-1 flex-col border-b border-[#333] min-h-0">
          <div className="border-b border-[#333] bg-[#1c1c1f] px-8 py-[15px] flex items-center justify-between">
            <span className="font-bold text-lg">🎼 乐谱视窗</span>
            <span className="text-[12px] text-[#666]">支持滚动查看</span>
          </div>
          <div className="flex flex-1 flex-col overflow-y-auto p-[25px]" style={{ backgroundImage: 'radial-gradient(#222 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
            {scoreImage ? (
              <img src={scoreImage} alt="Sheet Music" className="my-auto w-full rounded-lg shadow-[0_4px_10px_rgba(0,0,0,0.5)]" />
            ) : (
              <div className="my-auto text-center text-[#555]">
                未上传乐谱<br />
                <span className="text-[12px] text-[#444]">请点击"3. 乐谱"加载图片</span>
              </div>
            )}
          </div>
        </div>
          </div>
        </div>
        {/* 下半部分：演唱画像（常驻，横跨测评区+乐谱，填满其余空间，最小高度防塌陷） */}
        <div className="flex flex-1 flex-col border-t border-[#333] p-3 min-h-[260px] min-w-0 shrink-0">
          <button
            onClick={() => setPortraitExpanded(v => !v)}
            className="flex items-center justify-between mb-2 rounded-lg bg-[#1c1c1f] border border-[#333] px-3 py-2 text-sm font-bold text-white cursor-pointer hover:bg-[#242427] transition-colors"
          >
            <span>🎼 演唱画像 {studentScoreData.length > 0 && <span className="text-[12px] text-[#666]">（{studentScoreData[portraitStudentIndex]?.name}）</span>}</span>
            <span className="text-[#0a84ff]">
              {studentScoreData.length === 0 ? '即将展示' : (portraitExpanded ? '▲ 收起' : '▼ 展开')}
            </span>
          </button>
          <div className="flex flex-1 flex-col gap-2 mt-2 min-h-0 min-w-0">
            {studentScoreData.length > 0 ? (
              <>
                <div className="flex items-center justify-end">
                  <select 
                    value={portraitStudentIndex}
                    onChange={(e) => setPortraitStudentIndex(Number(e.target.value))}
                    className="text-xs bg-[#2a2a2d] border border-[#444] rounded px-2 py-1 text-white"
                  >
                    {studentScoreData.map((s, i) => (
                      <option key={i} value={i}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex-1 rounded-xl bg-[#1e1e20] border border-[#333] p-2 overflow-hidden min-h-0 min-w-0">
                  {portraitExpanded ? (
                    <SingingPortrait 
                      sampleData={portraitScore?.sampleData || []}
                      melodyData={portraitScore?.portraitReference ?? appDataRef.current.melodyData}
                      tolerance={portraitScore?.version ? SINGING_PRACTICE_TOLERANCE : 1.8}
                      allowAdjacentOctaves={portraitAllowsAdjacentOctaves}
                      studentName={portraitScore?.name || ''}
                    />
                  ) : (
                    <div className="h-full flex items-center justify-center text-[#555] text-sm">
                      点击「▼ 展开」查看演唱画像
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 rounded-xl bg-[#1e1e20] border border-[#333] flex items-center justify-center text-center text-[#555] text-sm">
                完成演唱后在此显示演唱画像
              </div>
            )}
          </div>
        </div>

      </div>
      {/* 移动端视图 */}
      <div className="md:hidden fixed inset-0 flex flex-col bg-[#121214]">
        {/* 移动端内容区 */}
        <div className="flex-1 overflow-y-auto pb-[70px]">
          {/* 主控台视图 - 始终挂载，使用 CSS 控制显示 */}
          <div className={`p-3 ${mobileTab === 'main' ? '' : 'hidden'}`}>
            <div className="rounded-2xl bg-[#1e1e20] p-4 border border-[#333]">
              <h2 className="mb-3 flex items-center justify-between text-sm font-bold">
                <span>🎹 智能声乐评测 <span style={{ fontSize: '10px', background: '#333', padding: '2px 4px', borderRadius: '4px', color: '#aaa' }}>V9.0</span></span>
                <span className="text-[#0a84ff] text-xs">
                  {refBuffer ? `第 ${students.length + 1} 位` : '等待文件'}
                </span>
              </h2>

              <div className="mb-3 grid grid-cols-3 gap-2">
                <div onClick={() => fileRefRef.current?.click()} className={`track-slot ${refBuffer ? 'loaded' : ''}`}>
                  <span className="icon-status text-base">{refBuffer ? '✅' : '🗣️'}</span>
                  <span className="slot-label text-[11px]">{refBuffer ? '干声' : '1.干声'}</span>
                  <span className="slot-desc text-[9px]">必选</span>
                </div>
                <div onClick={() => fileAccRef.current?.click()} className={`track-slot ${accBuffer ? 'loaded' : ''}`}>
                  <span className="icon-status text-base">{accBuffer ? '✅' : '🎼'}</span>
                  <span className="slot-label text-[11px]">{accBuffer ? '伴奏' : '2.伴奏'}</span>
                  <span className="slot-desc text-[9px]">可选</span>
                </div>
                <div onClick={() => fileScoreRef.current?.click()} className={`track-slot ${scoreImage ? 'loaded' : ''}`}>
                  <span className="icon-status text-base">{scoreImage ? '✅' : '📄'}</span>
                  <span className="slot-label text-[11px]">{scoreImage ? '乐谱' : '3.乐谱'}</span>
                  <span className="slot-desc text-[9px]">可选</span>
                </div>
              </div>

              <div className="relative h-[160px] mb-3 rounded-xl border-2 border-[#333] bg-black">
                <canvas ref={mobileCanvasRef} className="block h-full w-full" />
                <div className="absolute right-2 top-2 text-right">
                  <div className="text-[22px] font-black text-[#30d158]">{realtimeScore}</div>
                  <div className="text-[10px] text-[#aaa]">{realtimeStatus}</div>
                </div>
              </div>

              {refBuffer && <p className="mb-2 text-xs text-[#aaa]">{OCTAVE_GUIDE_HINT}</p>}
              {accLoaded && (
                <label className="mb-2 flex gap-2 text-xs text-[#ccc]">
                  <input type="checkbox" checked={pairConfirmed} disabled={sessionBusy}
                    onChange={event => setPairConfirmed(event.target.checked)} />
                  已确认干声和伴奏为同一乐段、同调、同速度，且从同一位置开始
                </label>
              )}
              <div className="grid grid-cols-2 gap-2">
                <button onClick={startSession} disabled={!refBuffer || students.length >= 4 || loading || sessionBusy || (accLoaded && !pairConfirmed)} className="btn btn-start py-3 text-sm">
                  🎙️ 第 {students.length + 1} 位
                </button>
                <button onClick={stopSession} disabled={!appDataRef.current.isPlaying} className="btn btn-stop py-3 text-sm">
                  ⏹ 结束
                </button>
              </div>

              {/* 移动端演唱画像区域 */}
              <div className="mt-3 rounded-xl bg-[#1e1e20] border border-[#333] p-2">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-white">🎼 演唱画像</span>
                  {studentScoreData.length > 0 && (
                    <select 
                      value={portraitStudentIndex}
                      onChange={(e) => setPortraitStudentIndex(Number(e.target.value))}
                      className="text-xs bg-[#2a2a2d] border border-[#444] rounded px-1 py-0.5 text-white"
                    >
                      {studentScoreData.map((s, i) => (
                        <option key={i} value={i}>{s.name}</option>
                      ))}
                    </select>
                  )}
                </div>
                {studentScoreData.length > 0 ? (
                  <div className="h-[340px]">
                    <SingingPortrait
                      sampleData={portraitScore?.sampleData || []}
                      melodyData={portraitScore?.portraitReference ?? appDataRef.current.melodyData}
                      tolerance={portraitScore?.version ? SINGING_PRACTICE_TOLERANCE : 1.8}
                      allowAdjacentOctaves={portraitAllowsAdjacentOctaves}
                      studentName={portraitScore?.name || ''}
                    />
                  </div>
                ) : (
                  <div className="h-[80px] flex items-center justify-center text-[#666] text-xs">
                    暂无演唱数据
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 课堂记录视图 */}
          {mobileTab === 'records' && (
            <div className="p-3">
              <div className="rounded-2xl bg-[#1e1e20] p-4 border border-[#333]">
                <div className="flex items-center justify-between mb-3">
                  <span className="font-bold text-sm">📋 课堂记录</span>
                  <span className="text-[#0a84ff] text-xs">{students.length} / 4</span>
                </div>
                <div className="space-y-3">
                  {studentCards.length === 0 ? (
                    <div className="text-center text-[#555] text-xs py-8">
                      暂无记录
                    </div>
                  ) : (
                    studentCards
                  )}
                </div>
                <div className="mt-4 flex flex-col gap-2">
                  <button onClick={handleShare} disabled={studentScoreData.length === 0 && !refBuffer} className="w-full bg-[#0a84ff] text-white py-3 rounded-lg text-sm disabled:opacity-50">
                    分享课堂
                  </button>
                  <button onClick={resetClassroom} className="w-full bg-[#333] text-[#aaa] py-3 rounded-lg text-sm">
                    重置课堂
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 乐谱视窗视图 */}
          {mobileTab === 'score' && (
            <div className="p-3 h-full">
              <div className="rounded-2xl bg-[#1e1e20] p-4 border border-[#333] h-full">
                <div className="flex items-center justify-between mb-3">
                  <span className="font-bold text-sm">🎼 乐谱视窗</span>
                </div>
                <div className="overflow-y-auto rounded-lg" style={{ backgroundImage: 'radial-gradient(#222 1px, transparent 1px)', backgroundSize: '16px 16px', maxHeight: 'calc(100vh - 180px)' }}>
                  {scoreImage ? (
                    <img src={scoreImage} alt="乐谱" className="w-full rounded-lg" />
                  ) : (
                    <div className="text-center text-[#555] text-xs py-12">
                      未上传乐谱<br />
                      <span className="text-[10px] text-[#444]">请点击"3. 乐谱"加载</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 移动端底部标签栏 */}
        <div className="fixed bottom-0 left-0 right-0 bg-[#1c1c1f] border-t border-[#333] flex">
          <button
            onClick={() => setMobileTab('main')}
            className={`flex-1 py-3 text-center text-xs ${mobileTab === 'main' ? 'text-[#0a84ff] border-t-2 border-[#0a84ff]' : 'text-[#666]'}`}
          >
            <div className="text-base mb-0.5">🎹</div>
            主控台
          </button>
          <button
            onClick={() => setMobileTab('records')}
            className={`flex-1 py-3 text-center text-xs ${mobileTab === 'records' ? 'text-[#0a84ff] border-t-2 border-[#0a84ff]' : 'text-[#666]'}`}
          >
            <div className="text-base mb-0.5">📋</div>
            课堂记录
          </button>
          <button
            onClick={() => setMobileTab('score')}
            className={`flex-1 py-3 text-center text-xs ${mobileTab === 'score' ? 'text-[#0a84ff] border-t-2 border-[#0a84ff]' : 'text-[#666]'}`}
          >
            <div className="text-base mb-0.5">🎼</div>
            乐谱视窗
          </button>
        </div>
      </div>
    </div>
  );
}
