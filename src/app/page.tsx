'use client';

import { useEffect, useRef, useState } from 'react';

// ================= 配置 (V8.3 暖心版参数) =================
const CONFIG = {
  scrollSpeed: 100,
  analyzePrecision: 0.05,
  tolerance: 2.2, // 容错值（提高到2.2，更宽松）
  minVol: 0.015   // 降低音量阈值，更容易检测
};

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
  pitch: string;
  rhythm: string;
  emotion: string;
}

// 乐句级别的得分
interface PhraseScore {
  id: number;
  startTime: number;
  endTime: number;
  pitch: number;
  rhythm: number;
  emotion: number;
}

// 学生完整评分数据（用于分享和恢复）
interface StudentScoreData {
  name: string;
  total: number;
  pitch: number;
  rhythm: number;
  emotion: number;
  rank: string;
  rankColor: string;
  comments: ScoreComments;
  phraseScores: PhraseScore[];
  audioUrl?: string; // 录音文件URL（分享后才有）
}

// 采样点数据（用于乐句分析）
interface SampleData {
  time: number;
  volume: number;
  hasPitch: boolean;
  isHit: boolean;
  pitchDiff?: number;
}

interface AppData {
  ctx: AudioContext | null;
  analyser: AnalyserNode | null;
  refBuffer: AudioBuffer | null;
  accBuffer: AudioBuffer | null;
  melodyData: MelodyPoint[];
  isPlaying: boolean;
  startTime: number;
  stats: {
    frames: number;
    hits: number;
    diffSum: number;
    teacherEnergy: number[];
    studentVol: number[];
    // 新增：采样点数据（用于乐句分析）
    sampleData: SampleData[];
  };
  currentSource: AudioBufferSourceNode | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  students: Student[];
}

export default function Home() {
  // Refs (用于可变数据，避免闭包问题)
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRefRef = useRef<HTMLInputElement>(null);
  const fileAccRef = useRef<HTMLInputElement>(null);
  const fileScoreRef = useRef<HTMLInputElement>(null);
  const appDataRef = useRef<AppData>({
    ctx: null,
    analyser: null,
    refBuffer: null,
    accBuffer: null,
    melodyData: [],
    isPlaying: false,
    startTime: 0,
    stats: {
      frames: 0,
      hits: 0,
      diffSum: 0,
      teacherEnergy: [],
      studentVol: [],
      sampleData: []
    },
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
  const [scoreImage, setScoreImage] = useState<string | null>(null);
  const [updateCounter, setUpdateCounter] = useState(0); // 用于触发 UI 更新
  const [shareLoading, setShareLoading] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  // ================= 1. 工具函数 =================
  const getRMS = (buf: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      sum += buf[i] * buf[i];
    }
    return Math.sqrt(sum / buf.length);
  };

  const autoCorrelate = (buf: Float32Array, sr: number): number | null => {
    const rms = getRMS(buf);
    if (rms < 0.01) return null;

    let size = buf.length;
    let r1 = 0, r2 = size - 1, thres = 0.2;
    for (let i = 0; i < size / 2; i++) {
      if (Math.abs(buf[i]) < thres) { r1 = i; break; }
    }
    for (let i = 1; i < size / 2; i++) {
      if (Math.abs(buf[size - i]) < thres) { r2 = size - i; break; }
    }

    buf = buf.slice(r1, r2);
    size = buf.length;

    let c = new Array(size).fill(0);
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size - i; j++) {
        c[i] += buf[j] * buf[j + i];
      }
    }

    let d = 0;
    while (c[d] > c[d + 1]) d++;

    let maxval = -1, maxpos = -1;
    for (let i = d; i < size; i++) {
      if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
    }

    return sr / maxpos;
  };

  const freqToMidi = (f: number): number => {
    return 69 + 12 * Math.log2(f / 440);
  };

  const getMidiY = (midi: number, h: number): number => {
    return h - ((midi - 45) / (85 - 45)) * h;
  };

  const showLoading = (show: boolean, text: string = 'Processing...') => {
    setLoading(show);
    setLoadingText(text);
  };

  // ================= 2. 旋律提取 =================
  const extractMelody = (buffer: AudioBuffer): MelodyPoint[] => {
    const data = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const step = Math.floor(sr * CONFIG.analyzePrecision);
    const result: MelodyPoint[] = [];

    for (let i = 0; i < data.length; i += step) {
      const slice = data.slice(i, i + 2048);
      const rms = getRMS(slice);
      if (rms > 0.015) {
        const freq = autoCorrelate(slice, sr);
        if (freq && freq > 60 && freq < 1100) {
          result.push({
            time: i / sr,
            midi: freqToMidi(freq),
            vol: rms
          });
        }
      }
    }
    return result;
  };

  // ================= 3. 文件上传处理 =================
  const loadFile = async (file: File | null, type: 'ref' | 'acc') => {
    if (!file) return;

    showLoading(true, '正在分析音频...');
    const ctx = appDataRef.current.ctx || new (window.AudioContext || (window as any).webkitAudioContext)();

    try {
      const ab = await file.arrayBuffer();
      const buffer = await ctx.decodeAudioData(ab);

      if (type === 'ref') {
        const melodyData = extractMelody(buffer);
        appDataRef.current.ctx = ctx;
        appDataRef.current.refBuffer = buffer;
        appDataRef.current.melodyData = melodyData;
        setUpdateCounter(prev => prev + 1);
        // 上传干声后启动预览模式
        setTimeout(() => drawLoop(true), 100);
      } else {
        appDataRef.current.ctx = ctx;
        appDataRef.current.accBuffer = buffer;
        setUpdateCounter(prev => prev + 1);
      }
    } catch (e) {
      console.error('文件加载失败:', e);
      alert('文件加载失败');
    }

    showLoading(false);
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
    if (data.students.length >= 4) return;
    if (!data.ctx || !data.refBuffer) return;

    if (data.ctx.state === 'suspended') {
      await data.ctx.resume();
    }

    const source = data.ctx.createBufferSource();
    source.buffer = data.accBuffer || data.refBuffer;
    source.connect(data.ctx.destination);
    source.start(0);

    data.currentSource = source;
    data.startTime = data.ctx.currentTime;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const micSource = data.ctx.createMediaStreamSource(stream);
      const analyser = data.ctx.createAnalyser();
      analyser.fftSize = 2048;
      micSource.connect(analyser);

      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.start();

      data.analyser = analyser;
      data.recorder = recorder;
      data.chunks = chunks;
      data.isPlaying = true;
      data.stats = {
        frames: 0,
        hits: 0,
        diffSum: 0,
        teacherEnergy: [],
        studentVol: [],
        sampleData: []
      };

      setRealtimeStatus('Recording...');
      setRealtimeScore('--');
      setUpdateCounter(prev => prev + 1);

      source.onended = stopSession;
      drawLoop();
    } catch (err) {
      console.error('麦克风启动失败:', err);
      alert('麦克风启动失败');
    }
  };

  const stopSession = () => {
    const data = appDataRef.current;
    if (!data.isPlaying) return;

    data.isPlaying = false;
    setUpdateCounter(prev => prev + 1);

    if (data.currentSource) data.currentSource.stop();
    if (data.recorder && data.recorder.state !== 'inactive') {
      data.recorder.stop();
      data.recorder.onstop = () => {
        const blob = new Blob(data.chunks, { type: 'audio/webm' });
        calculateBalancedScore(blob);
        setRealtimeStatus('Finished');
      };
    }
  };

  // ================= 5. 实时绘制 =================
  const drawLoop = (preview = false) => {
    const data = appDataRef.current;

    // 预览模式：只显示旋律线，不停止
    // 实时模式：正在播放时才继续
    if (!preview && !data.isPlaying) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

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

    // 绘制参考音符
    const centerX = w / 3;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    let currentNote: MelodyPoint | undefined;

    const melodyData = data.melodyData;
    for (let i = 0; i < melodyData.length; i++) {
      const p = melodyData[i];
      const x = centerX + (p.time - now) * CONFIG.scrollSpeed;
      if (x > -10 && x < w) {
        const y = getMidiY(p.midi, h);
        ctx.fillRect(x, y - 3, 4, 6);
        if (Math.abs(x - centerX) < 5) currentNote = p;
      }
    }

    // 分析用户音高（仅非预览模式）
    if (!preview && data.analyser) {
      const buffer = new Float32Array(2048);
      data.analyser.getFloatTimeDomainData(buffer);
      const rms = getRMS(buffer);
      const freq = autoCorrelate(buffer, data.ctx!.sampleRate);

      if (rms > 0.01) {
        data.stats.studentVol.push(rms);

        // 统计检测到有效音高的帧数（无论是否有currentNote）
        if (freq && freq > 60) {
          data.stats.frames = data.stats.frames + 1;
        }

        if (freq && freq > 60) {
          const userMidi = freqToMidi(freq);
          let displayMidi = userMidi;
          let isHit = false;
          let pitchDiff = 0;

          if (currentNote) {
            const diff = currentNote.midi - userMidi;
            const octOffset = 12 * Math.round(diff / 12);
            const normDiff = Math.abs(currentNote.midi - (userMidi + octOffset));

            data.stats.diffSum = data.stats.diffSum + normDiff;
            pitchDiff = normDiff;

            displayMidi = userMidi + octOffset;

            if (normDiff < CONFIG.tolerance) {
              isHit = true;
              data.stats.hits = data.stats.hits + 1;
              setRealtimeScore('✨');
              if (normDiff < 1.0) displayMidi = currentNote.midi;
            } else {
              setRealtimeScore(diff > 0 ? '📉' : '📈');
            }
          }

          const y = getMidiY(displayMidi, h);
          ctx.beginPath();
          ctx.arc(centerX, y, 8, 0, Math.PI * 2);
          ctx.fillStyle = isHit ? '#30d158' : '#ff453a';
          ctx.fill();

          // 记录采样点数据（用于乐句分析）
          data.stats.sampleData.push({
            time: now,
            volume: rms,
            hasPitch: true,
            isHit: isHit,
            pitchDiff: pitchDiff
          });
        } else {
          setRealtimeScore('...');
          // 记录采样点数据（有声音但无音高）
          data.stats.sampleData.push({
            time: now,
            volume: rms,
            hasPitch: false,
            isHit: false
          });
        }
      } else {
        // 记录采样点数据（无声音）
        data.stats.sampleData.push({
          time: now,
          volume: rms,
          hasPitch: false,
          isHit: false
        });
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

  // ================= 6. 评分算法 =================
  const calculateBalancedScore = (blob: Blob) => {
    const stats = appDataRef.current.stats;
    const melodyData = appDataRef.current.melodyData;

    // ========== 音准评分（50%）==========
    // 1. 命中率（60%权重）
    const rawAccuracy = stats.frames > 0 ? stats.hits / stats.frames : 0;
    let accuracyScore = rawAccuracy * 60;

    // 2. 音高偏差（40%权重）
    const avgDiff = stats.frames > 0 ? stats.diffSum / stats.frames : 0;
    let precisionScore = 0;
    if (avgDiff <= 0.8) precisionScore = 40;      // 非常精准
    else if (avgDiff <= 1.2) precisionScore = 35; // 很好
    else if (avgDiff <= 1.8) precisionScore = 30; // 不错
    else if (avgDiff <= 2.5) precisionScore = 25; // 一般
    else if (avgDiff <= 3.5) precisionScore = 20; // 较差
    else precisionScore = 15;                     // 很差

    // 综合音准分
    let scorePitch = Math.round(accuracyScore + precisionScore);

    // 最高不超过100，最低不低于50
    scorePitch = Math.min(100, Math.max(50, scorePitch));

    // ========== 节奏评分（30%）- 专业版 ==========
    const teacherTotal = melodyData.length;

    // 完成度：基于演唱时长判断（最关键的指标）
    // stats.studentVol.length 是总采样次数（rms > 0.01的帧数）
    // 实际采样间隔约 46.4ms（2048 / 44100 ≈ 0.0464秒）
    const sampleInterval = 2048 / 44100; // 实际采样间隔
    const duration = stats.studentVol.length * sampleInterval;
    const refDuration = melodyData.length > 0 ? melodyData[melodyData.length - 1].time : 0;
    const completion = refDuration > 0 ? Math.min(duration / refDuration, 1) : 0;

    // 覆盖率：学生演唱的帧数 / 参考音符总数（辅助指标）
    const coverage = teacherTotal > 0 ? stats.frames / teacherTotal : 0;

    // 节奏稳定性分析：通过分析音量波动的规律性
    const studentVol = stats.studentVol;
    let rhythmStability = 0; // 节拍稳定性评分
    let noteAccuracy = 0;   // 时值准确性评分
    let articulation = 0;   // 起音收音控制评分

    if (studentVol.length > 10) {
      // 分析音量变化的平滑度（用于判断节奏的连贯性）
      let volSmoothness = 0;
      for (let i = 1; i < studentVol.length; i++) {
        volSmoothness += Math.abs(studentVol[i] - studentVol[i - 1]);
      }
      volSmoothness = volSmoothness / (studentVol.length - 1);

      // 分析起音（音量突增）和收音（音量衰减）的控制
      let attackCount = 0;  // 起音次数
      let decayCount = 0;   // 收音次数
      let smoothTransitions = 0; // 平滑过渡次数

      for (let i = 2; i < studentVol.length - 2; i++) {
        const prev = studentVol[i - 1];
        const curr = studentVol[i];
        const next = studentVol[i + 1];

        // 检测起音（音量快速上升）
        if (curr > prev * 1.5 && curr > 0.02 && next >= curr * 0.9) {
          attackCount++;
        }
        // 检测收音（音量快速下降）
        if (curr < prev * 0.6 && curr < 0.02) {
          decayCount++;
        }
        // 检测平滑过渡
        if (Math.abs(curr - prev) < 0.005 && Math.abs(next - curr) < 0.005) {
          smoothTransitions++;
        }
      }

      // 节拍稳定性评分（25分）
      // 音量变化过于频繁说明节奏不稳定
      if (volSmoothness < 0.003) rhythmStability = 25;   // 非常稳定
      else if (volSmoothness < 0.005) rhythmStability = 23;
      else if (volSmoothness < 0.008) rhythmStability = 21;
      else if (volSmoothness < 0.012) rhythmStability = 19;
      else if (volSmoothness < 0.018) rhythmStability = 17;
      else if (volSmoothness < 0.025) rhythmStability = 15;
      else rhythmStability = 12;                          // 波动过大

      // 时值准确性评分（20分）
      // 通过起音和收音的比例判断时值控制
      if (attackCount > 0 && decayCount > 0) {
        const noteRatio = Math.min(attackCount / Math.max(decayCount, 1), decayCount / Math.max(attackCount, 1));
        if (noteRatio > 0.8) noteAccuracy = 20;          // 时值准确
        else if (noteRatio > 0.6) noteAccuracy = 18;
        else if (noteRatio > 0.4) noteAccuracy = 16;
        else noteAccuracy = 14;
      } else {
        noteAccuracy = 15; // 起音收音不够清晰
      }

      // 起音收音控制评分（5分）
      if (smoothTransitions > studentVol.length * 0.3) articulation = 5;
      else if (smoothTransitions > studentVol.length * 0.2) articulation = 4;
      else if (smoothTransitions > studentVol.length * 0.1) articulation = 3;
      else articulation = 2;
    }

    // 完成度评分（50%权重）
    let completionScore = 0;
    if (completion >= 0.95) completionScore = 50;      // 完整演唱
    else if (completion >= 0.9) completionScore = 48;
    else if (completion >= 0.85) completionScore = 45;
    else if (completion >= 0.8) completionScore = 42;
    else if (completion >= 0.75) completionScore = 38;
    else if (completion >= 0.7) completionScore = 35;   // 范唱至少应该达到35分
    else if (completion >= 0.65) completionScore = 30;
    else if (completion >= 0.6) completionScore = 25;
    else if (completion >= 0.55) completionScore = 20;
    else if (completion >= 0.5) completionScore = 15;
    else if (completion >= 0.4) completionScore = 10;
    else completionScore = 5;

    // 节奏评分 = 完成度(50%) + 节拍稳定性(25%) + 时值准确性(20%) + 起音收音(5%)
    const scoreRhythm = Math.min(100, completionScore + rhythmStability + noteAccuracy + articulation);

    // ========== 情绪评分（20%）- 专业版 ==========
    if (studentVol.length === 0) {
      return;
    }

    // 计算各项指标
    const volMean = studentVol.reduce((a, b) => a + b, 0) / studentVol.length;
    const volMin = Math.min(...studentVol);
    const volMax = Math.max(...studentVol);
    const dynamicRange = volMax - volMin;
    const volStd = Math.sqrt(studentVol.reduce((a, b) => a + Math.pow(b - volMean, 2), 0) / studentVol.length);

    // 连贯性分析：声音是否流畅，是否有断音
    let smoothnessScore = 0;
    let pauseCount = 0;
    for (let i = 1; i < studentVol.length; i++) {
      if (studentVol[i] < 0.01 && studentVol[i - 1] >= 0.01) {
        pauseCount++;
      }
    }
    const pauseRatio = pauseCount / (studentVol.length / 50); // 每秒的停顿次数

    // 气息控制分析：音量持续能力和稳定性
    let breathControl = 0;
    let sustainSegments = 0;
    let currentSegment = 0;
    for (let i = 0; i < studentVol.length; i++) {
      if (studentVol[i] > 0.02) {
        currentSegment++;
        if (currentSegment > 10) { // 持续超过10帧视为有效气息
          sustainSegments++;
        }
      } else {
        currentSegment = 0;
      }
    }
    const sustainRatio = sustainSegments / (studentVol.length / 20);

    // 基础分
    let scoreEmotion = 50;

    // 音量评分（35分权重）
    let volScore = 0;
    if (volMean >= 0.05) volScore = 35;           // 音量很充足
    else if (volMean >= 0.04) volScore = 33;      // 音量充足
    else if (volMean >= 0.03) volScore = 30;      // 音量较好
    else if (volMean >= 0.02) volScore = 25;      // 音量适中
    else if (volMean >= 0.015) volScore = 20;     // 音量偏小
    else volScore = 15;                            // 音量太小

    scoreEmotion += volScore;

    // 动态范围评分（25分权重）
    let dynamicScore = 0;
    if (dynamicRange >= 0.06) dynamicScore = 25;   // 动态范围很大
    else if (dynamicRange >= 0.05) dynamicScore = 23;
    else if (dynamicRange >= 0.04) dynamicScore = 21;
    else if (dynamicRange >= 0.03) dynamicScore = 18;
    else if (dynamicRange >= 0.02) dynamicScore = 15;
    else dynamicScore = 12;                        // 动态范围小

    scoreEmotion += dynamicScore;

    // 连贯性评分（25分权重）
    if (pauseRatio < 0.1) smoothnessScore = 25;    // 非常连贯
    else if (pauseRatio < 0.3) smoothnessScore = 23;
    else if (pauseRatio < 0.5) smoothnessScore = 20;
    else if (pauseRatio < 0.8) smoothnessScore = 17;
    else if (pauseRatio < 1.2) smoothnessScore = 15;
    else smoothnessScore = 12;                     // 断音过多

    scoreEmotion += smoothnessScore;

    // 气息控制评分（15分权重）
    if (sustainRatio > 0.6) breathControl = 15;    // 气息控制很好
    else if (sustainRatio > 0.5) breathControl = 13;
    else if (sustainRatio > 0.4) breathControl = 11;
    else if (sustainRatio > 0.3) breathControl = 9;
    else breathControl = 7;                         // 气息不足

    scoreEmotion += breathControl;

    // 最高不超过100，最低不低于50
    scoreEmotion = Math.min(100, Math.max(50, scoreEmotion));

    // ========== 综合评分 ==========
    let total = Math.round(scorePitch * 0.5 + scoreRhythm * 0.3 + scoreEmotion * 0.2);

    // 鼓励性调整（V8.9 精准版）
    // 只在演唱完成度较高时才给予高分保底，避免只唱几句也得高分
    if (completion >= 0.8) {
      // 演唱完成度80%以上（完整演唱）
      if (scorePitch >= 85 && scoreEmotion >= 85) {
        total = Math.max(total, 95);
      }
      if (scorePitch >= 80 && scoreEmotion >= 80) {
        total = Math.max(total, 90);
      }
      if (scoreRhythm >= 80 && total < 90) {
        total = 90;
      }
      if (scoreRhythm >= 70 && total < 85) {
        total = 85;
      }
    } else if (completion >= 0.7) {
      // 演唱完成度70%以上（基本完整）
      if (scorePitch >= 85 && scoreEmotion >= 85) {
        total = Math.max(total, 90);
      }
      if (scorePitch >= 80 && scoreEmotion >= 80) {
        total = Math.max(total, 85);
      }
      if (scoreRhythm >= 65 && total < 80) {
        total = 80;
      }
    } else if (completion >= 0.5) {
      // 演唱完成度50%以上（一般）
      if (scorePitch >= 80 && scoreEmotion >= 80) {
        total = Math.max(total, 75);
      }
    }
    // 完成度低于50%的不给予额外保底

    // ========== 乐句识别和乐句级评分 ==========
    const sampleData = stats.sampleData;
    const phraseScores: PhraseScore[] = [];

    if (sampleData.length > 50) {
      // 检测乐句边界（基于音量停顿点）
      const phrases: { startTime: number; endTime: number; samples: SampleData[] }[] = [];
      let currentPhrase: SampleData[] = [];
      let inPhrase = false;
      let silenceFrames = 0;

      // 参数配置
      const SILENCE_THRESHOLD = 0.01;  // 静音阈值
      const MIN_SILENCE_FRAMES = 10;   // 最小静音帧数（约0.46秒）
      const MIN_PHRASE_SAMPLES = 15;   // 最小乐句样本数（约0.7秒）
      const MAX_PHRASE_GAP = 200;      // 最大乐句间隔（样本数）

      for (let i = 0; i < sampleData.length; i++) {
        const sample = sampleData[i];

        if (sample.volume > SILENCE_THRESHOLD) {
          // 有声音
          if (!inPhrase) {
            // 新的乐句开始
            if (currentPhrase.length >= MIN_PHRASE_SAMPLES) {
              phrases.push({
                startTime: currentPhrase[0].time,
                endTime: currentPhrase[currentPhrase.length - 1].time,
                samples: [...currentPhrase]
              });
            }
            currentPhrase = [];
          }
          currentPhrase.push(sample);
          inPhrase = true;
          silenceFrames = 0;
        } else {
          // 无声音
          silenceFrames++;
          if (silenceFrames > MIN_SILENCE_FRAMES) {
            // 静音时间足够长，乐句结束
            if (currentPhrase.length >= MIN_PHRASE_SAMPLES) {
              phrases.push({
                startTime: currentPhrase[0].time,
                endTime: currentPhrase[currentPhrase.length - 1].time,
                samples: [...currentPhrase]
              });
            }
            currentPhrase = [];
            inPhrase = false;
          }
        }
      }

      // 处理最后一个乐句
      if (currentPhrase.length >= MIN_PHRASE_SAMPLES) {
        phrases.push({
          startTime: currentPhrase[0].time,
          endTime: currentPhrase[currentPhrase.length - 1].time,
          samples: [...currentPhrase]
        });
      }

      // 合并相邻的乐句（如果间隔太小）
      const mergedPhrases: typeof phrases = [];
      for (const phrase of phrases) {
        if (mergedPhrases.length === 0) {
          mergedPhrases.push(phrase);
        } else {
          const lastPhrase = mergedPhrases[mergedPhrases.length - 1];
          const gapInSamples = (phrase.startTime - lastPhrase.endTime) / (2048 / 44100) / (2048 / 44100);
          if (gapInSamples < MAX_PHRASE_GAP) {
            // 合并乐句
            lastPhrase.endTime = phrase.endTime;
            lastPhrase.samples.push(...phrase.samples);
          } else {
            mergedPhrases.push(phrase);
          }
        }
      }

      // 为每个乐句计算得分
      const sampleInterval = 2048 / 44100;

      for (let i = 0; i < mergedPhrases.length; i++) {
        const phrase = mergedPhrases[i];
        const phraseSamples = phrase.samples;

        // 音准评分
        const pitchSamples = phraseSamples.filter(s => s.hasPitch);
        const pitchFrames = pitchSamples.length;
        const pitchHits = pitchSamples.filter(s => s.isHit).length;
        const pitchAvgDiff = pitchSamples.length > 0
          ? pitchSamples.reduce((sum, s) => sum + (s.pitchDiff || 0), 0) / pitchSamples.length
          : 0;

        let phrasePitchScore = 50;
        if (pitchFrames > 0) {
          const accuracy = pitchHits / pitchFrames;
          let accuracyScore = accuracy * 60;
          let precisionScore = 0;
          if (pitchAvgDiff <= 0.8) precisionScore = 40;
          else if (pitchAvgDiff <= 1.2) precisionScore = 35;
          else if (pitchAvgDiff <= 1.8) precisionScore = 30;
          else if (pitchAvgDiff <= 2.5) precisionScore = 25;
          else if (pitchAvgDiff <= 3.5) precisionScore = 20;
          else precisionScore = 15;
          phrasePitchScore = Math.min(100, Math.max(50, accuracyScore + precisionScore));
        }

        // 节奏评分
        const phraseDuration = phraseSamples.length * sampleInterval;
        const totalDuration = sampleData.length * sampleInterval;
        const phraseCompletion = totalDuration > 0 ? phraseDuration / totalDuration : 0;

        let phraseRhythmScore = 50;
        if (phraseSamples.length > 10) {
          const volSmoothness = phraseSamples.reduce((sum, s, idx) => {
            if (idx === 0) return 0;
            return sum + Math.abs(s.volume - phraseSamples[idx - 1].volume);
          }, 0) / (phraseSamples.length - 1);

          let rhythmStabilityScore = 0;
          if (volSmoothness < 0.003) rhythmStabilityScore = 25;
          else if (volSmoothness < 0.005) rhythmStabilityScore = 23;
          else if (volSmoothness < 0.008) rhythmStabilityScore = 21;
          else if (volSmoothness < 0.012) rhythmStabilityScore = 19;
          else if (volSmoothness < 0.018) rhythmStabilityScore = 17;
          else rhythmStabilityScore = 12;

          const phraseVol = phraseSamples.map(s => s.volume);
          const phraseVolMean = phraseVol.reduce((a, b) => a + b, 0) / phraseVol.length;
          const phraseDynamicRange = Math.max(...phraseVol) - Math.min(...phraseVol);

          let dynamicScore = 0;
          if (phraseDynamicRange >= 0.05) dynamicScore = 15;
          else if (phraseDynamicRange >= 0.04) dynamicScore = 13;
          else if (phraseDynamicRange >= 0.03) dynamicScore = 11;
          else dynamicScore = 8;

          phraseRhythmScore = Math.min(100, rhythmStabilityScore + dynamicScore + 10);
        }

        // 情绪评分
        let phraseEmotionScore = 50;
        if (phraseSamples.length > 10) {
          const phraseVol = phraseSamples.map(s => s.volume);
          const phraseVolMean = phraseVol.reduce((a, b) => a + b, 0) / phraseVol.length;
          const phraseVolMax = Math.max(...phraseVol);
          const phraseVolMin = Math.min(...phraseVol);
          const phraseDynamicRange = phraseVolMax - phraseVolMin;

          let volScore = 0;
          if (phraseVolMean >= 0.05) volScore = 35;
          else if (phraseVolMean >= 0.04) volScore = 33;
          else if (phraseVolMean >= 0.03) volScore = 30;
          else if (phraseVolMean >= 0.02) volScore = 25;
          else if (phraseVolMean >= 0.015) volScore = 20;
          else volScore = 15;

          let dynamicScore = 0;
          if (phraseDynamicRange >= 0.06) dynamicScore = 25;
          else if (phraseDynamicRange >= 0.05) dynamicScore = 23;
          else if (phraseDynamicRange >= 0.04) dynamicScore = 21;
          else if (phraseDynamicRange >= 0.03) dynamicScore = 18;
          else dynamicScore = 12;

          let pauseCount = 0;
          for (let j = 1; j < phraseSamples.length; j++) {
            if (phraseSamples[j].volume < 0.01 && phraseSamples[j - 1].volume >= 0.01) {
              pauseCount++;
            }
          }
          const pauseRatio = pauseCount / (phraseSamples.length / 50);

          let smoothnessScore = 0;
          if (pauseRatio < 0.1) smoothnessScore = 25;
          else if (pauseRatio < 0.3) smoothnessScore = 23;
          else if (pauseRatio < 0.5) smoothnessScore = 20;
          else if (pauseRatio < 0.8) smoothnessScore = 17;
          else smoothnessScore = 12;

          phraseEmotionScore = Math.min(100, volScore + dynamicScore + smoothnessScore);
        }

        phraseScores.push({
          id: i + 1,
          startTime: phrase.startTime,
          endTime: phrase.endTime,
          pitch: phrasePitchScore,
          rhythm: phraseRhythmScore,
          emotion: phraseEmotionScore
        });
      }
    }

    const comments = generateDetailedComments(
      scorePitch,
      scoreRhythm,
      scoreEmotion,
      total,
      avgDiff,
      coverage,
      completion,
      rhythmStability,
      noteAccuracy,
      articulation,
      pauseRatio,
      sustainRatio,
      dynamicRange,
      volStd,
      phraseScores
    );
    addStudentCard(total, scorePitch, scoreRhythm, scoreEmotion, comments, blob, phraseScores);
  };

  const generateDetailedComments = (
    p: number,
    r: number,
    e: number,
    total: number,
    avgDiff: number,
    coverage: number,
    completion: number,
    rhythmStability: number,
    noteAccuracy: number,
    articulation: number,
    pauseRatio: number,
    sustainRatio: number,
    dynamicRange: number,
    volStd: number,
    phraseScores: PhraseScore[]
  ): ScoreComments => {
    // ========== 音准评语（保持现有，增加专业指导）==========
    const pitchComments = {
      perfect: [
        "音准极其精准！每个音都落在标准位置，专业级听觉表现！",
        "音高控制能力卓越，听感舒适稳定，音准偏差极小！",
        "音准完美！几乎零误差，完全符合专业演唱标准！"
      ],
      excellent: [
        "音准非常出色！绝大部分音都准确到位，听觉体验极佳！",
        "音高控制优秀，偶有小偏差但不影响整体音乐表现！",
        "音准表现优秀！核心音符非常稳定，令人满意！"
      ],
      good: [
        "音准表现良好！大部分音符准确，注意细节音准会更出色！",
        "整体音准达标，多做音阶练习有助于提升精确度！",
        "音准基本合格，注意半音和全音的细微差异会更好！"
      ],
      fair: [
        "音准有波动，建议每天练习音阶和琶音，提升听觉敏感度！",
        "部分音高需要调整，多听多唱，培养固定音准感！",
        "音准还在发展中，建议用钢琴辅助练习，找准每个音位！"
      ],
      poor: [
        "音准需要加强，建议从基础音阶开始，每天坚持练习！",
        "音高控制还有较大进步空间，跟着范唱慢速练习很重要！",
        "音准需要系统训练，多听专业演唱，培养音准意识！"
      ]
    };

    let cPitch = "";
    if (p >= 95) cPitch = pitchComments.perfect[Math.floor(Math.random() * pitchComments.perfect.length)];
    else if (p >= 85) cPitch = pitchComments.excellent[Math.floor(Math.random() * pitchComments.excellent.length)];
    else if (p >= 75) cPitch = pitchComments.good[Math.floor(Math.random() * pitchComments.good.length)];
    else if (p >= 60) cPitch = pitchComments.fair[Math.floor(Math.random() * pitchComments.fair.length)];
    else cPitch = pitchComments.poor[Math.floor(Math.random() * pitchComments.poor.length)];

    // 根据具体偏差补充专业评语
    if (avgDiff > 3) {
      cPitch += " 平均偏差超过3个半音，需要重点练习音程听辨！";
    } else if (avgDiff > 2.5) {
      cPitch += " 音准偏差明显，建议用慢速演唱练习！";
    } else if (avgDiff > 1.8) {
      cPitch += " 音准有提升空间，注意音准预判和气息稳定！";
    } else if (avgDiff < 0.8) {
      cPitch += " 平均偏差极小，音准控制达到专业水准！";
    }

    // ========== 节奏评语（专业版 - 根据具体指标给出针对性指导）==========
    // 根据完成度、节奏稳定性、时值准确性、起音收音控制综合判断
    let rhythmMainComment = "";
    let rhythmTechnicalComment = "";

    // 主要评语（基于总分）
    if (r >= 95) {
      rhythmMainComment = "节奏掌控卓越！专业级别的节奏控制，完美驾驭音乐！";
    } else if (r >= 90) {
      rhythmMainComment = "节奏感极佳！绝大部分节拍精准，乐感十足！";
    } else if (r >= 85) {
      rhythmMainComment = "节奏非常出色！整体节奏流畅，控制力很强！";
    } else if (r >= 80) {
      rhythmMainComment = "节奏表现优秀！基本跟上音乐骨架，偶有细微波动！";
    } else if (r >= 75) {
      rhythmMainComment = "节奏良好！大部分时间卡点准确，继续保持！";
    } else if (r >= 70) {
      rhythmMainComment = "节奏基本准确！注意保持稳定的速度感！";
    } else if (r >= 65) {
      rhythmMainComment = "节奏尚可，需要加强稳定性训练！";
    } else if (r >= 60) {
      rhythmMainComment = "节奏需要提升，建议用节拍器辅助练习！";
    } else if (r >= 50) {
      rhythmMainComment = "节奏感较弱，建议从基础节奏型开始练习！";
    } else {
      rhythmMainComment = "节奏需要重点突破，多听多练是关键！";
    }

    // 技术性评语（基于具体指标）
    if (completion < 0.5) {
      rhythmTechnicalComment += " 演唱完整度偏低，建议完整唱完每首歌！";
    } else if (completion < 0.7) {
      rhythmTechnicalComment += " 完整度有待提高，跟上音乐的完整进程！";
    }

    if (rhythmStability < 15) {
      rhythmTechnicalComment += " 节拍稳定性不足，节奏时快时慢，建议用节拍器练习！";
    } else if (rhythmStability < 20) {
      rhythmTechnicalComment += " 节拍波动较大，注意保持恒定的速度！";
    }

    if (noteAccuracy < 16) {
      rhythmTechnicalComment += " 音符时值控制不准，建议练习音符长短！";
    } else if (noteAccuracy < 18) {
      rhythmTechnicalComment += " 时值准确性有提升空间，注意音符的完整性！";
    }

    if (articulation < 4) {
      rhythmTechnicalComment += " 起音收音不够清晰，建议练习吐字发音的连贯性！";
    }

    // 如果没有技术性问题，给予正面反馈
    if (!rhythmTechnicalComment) {
      if (rhythmStability >= 23 && noteAccuracy >= 18 && articulation >= 4) {
        rhythmTechnicalComment += " 起音收音清晰，时值准确，节拍稳定，节奏基本功扎实！";
      } else {
        rhythmTechnicalComment += " 节奏表现全面，继续加强细节控制！";
      }
    }

    const cRhythm = rhythmMainComment + rhythmTechnicalComment;

    // ========== 情绪评语（专业版 - 根据连贯性、气息、动态等指标给出针对性指导）==========
    // 根据连贯性、气息控制、动态范围、稳定性综合判断
    let emotionMainComment = "";
    let emotionTechnicalComment = "";

    // 主要评语（基于总分）
    if (e >= 95) {
      emotionMainComment = "情感表达卓越！专业级的情绪掌控，感染力极强！";
    } else if (e >= 90) {
      emotionMainComment = "情感表达出色！声音富有层次，能打动听众！";
    } else if (e >= 85) {
      emotionMainComment = "情感丰富！声音有起伏，演唱很有感染力！";
    } else if (e >= 80) {
      emotionMainComment = "情绪表达良好！强弱对比明显，听感舒适！";
    } else if (e >= 75) {
      emotionMainComment = "情绪尚可，声音有一定的变化和层次！";
    } else if (e >= 70) {
      emotionMainComment = "情绪表现一般，建议更自然地流露情感！";
    } else if (e >= 65) {
      emotionMainComment = "情感表达有待提高，尝试更投入地演唱！";
    } else if (e >= 60) {
      emotionMainComment = "声音较为平淡，建议感受歌曲的情感变化！";
    } else if (e >= 50) {
      emotionMainComment = "声音缺乏变化，多听原唱学习情感表达！";
    } else {
      emotionMainComment = "声音需要大幅提升，加强情感投入和技巧训练！";
    }

    // 技术性评语（基于具体指标）
    const volMean = appDataRef.current.stats.studentVol.length > 0
      ? appDataRef.current.stats.studentVol.reduce((a, b) => a + b, 0) / appDataRef.current.stats.studentVol.length
      : 0;

    if (volMean < 0.02) {
      emotionTechnicalComment += " 整体音量偏小，建议大胆发声，提升音量！";
    } else if (volMean < 0.03) {
      emotionTechnicalComment += " 音量适中，可以再放开一些！";
    }

    if (dynamicRange < 0.03) {
      emotionTechnicalComment += " 动态范围偏小，声音缺乏起伏，建议练习强弱对比！";
    } else if (dynamicRange < 0.04) {
      emotionTechnicalComment += " 强弱对比还可以，可以更鲜明一些！";
    }

    if (pauseRatio > 1.2) {
      emotionTechnicalComment += " 声音断续明显，连贯性不足，建议练习气息支持！";
    } else if (pauseRatio > 0.8) {
      emotionTechnicalComment += " 停顿较多，注意乐句的连贯演唱！";
    } else if (pauseRatio < 0.1) {
      emotionTechnicalComment += " 声音非常连贯，流畅度极佳！";
    }

    if (sustainRatio < 0.4) {
      emotionTechnicalComment += " 气息控制较弱，长音支撑不足，建议练习腹式呼吸！";
    } else if (sustainRatio < 0.5) {
      emotionTechnicalComment += " 气息支持有待提高，加强气息训练！";
    } else if (sustainRatio > 0.6) {
      emotionTechnicalComment += " 气息控制优秀，长音支撑能力强！";
    }

    if (volStd > 0.08) {
      emotionTechnicalComment += " 声音稳定性不足，波动较大，注意气息平稳！";
    } else if (volStd > 0.06) {
      emotionTechnicalComment += " 声音稳定性可以提升，控制好音量变化！";
    }

    // 如果没有技术性问题，给予正面反馈
    if (!emotionTechnicalComment) {
      if (dynamicRange >= 0.05 && pauseRatio < 0.3 && sustainRatio > 0.5) {
        emotionTechnicalComment += " 气息控制优秀，连贯性强，动态范围丰富，情感表达完整！";
      } else {
        emotionTechnicalComment += " 情绪表达全面，继续完善细节！";
      }
    }

    const cEmotion = emotionMainComment + emotionTechnicalComment;

    return { pitch: cPitch, rhythm: cRhythm, emotion: cEmotion };
  };

  const addStudentCard = (
    total: number,
    p: number,
    r: number,
    e: number,
    comments: ScoreComments,
    blob: Blob,
    phraseScores: PhraseScore[] = []
  ) => {
    const data = appDataRef.current;
    const name = `同学 ${String.fromCharCode(65 + data.students.length)}`;
    let rank = 'C';
    let color = '#ff453a';

    // 调整等级标准，更加鼓励
    if (total >= 95) { rank = 'S+'; color = '#ffd60a'; } // 金色
    else if (total >= 90) { rank = 'S'; color = '#ffd60a'; }
    else if (total >= 85) { rank = 'A+'; color = '#30d158'; }
    else if (total >= 80) { rank = 'A'; color = '#30d158'; }
    else if (total >= 75) { rank = 'B+'; color = '#0a84ff'; }
    else if (total >= 70) { rank = 'B'; color = '#0a84ff'; }
    else if (total >= 65) { rank = 'B-'; color = '#0a84ff'; } // 改为B-，更鼓励
    else if (total >= 60) { rank = 'C'; color = '#ff453a'; }
    else if (total >= 55) { rank = 'C-'; color = '#ff453a'; }
    else { rank = 'D'; color = '#ff6b6b'; }

    // 生成歌曲得分明细的UI
    const phraseDetails = phraseScores.length > 0 ? (
      <div className="phrase-details mt-3">
        <div className="phrase-details-header">
          <span>📊 歌曲得分明细</span>
          <span style={{ marginLeft: 'auto', fontSize: '11px', fontWeight: 'normal' }}>
            共 {phraseScores.length} 个片段
          </span>
        </div>
        <div className="phrase-details-content">
          {phraseScores.map((phrase) => (
            <div key={phrase.id} className="phrase-item">
              <div className="phrase-time-badge">
                {phrase.startTime.toFixed(1)}s-{phrase.endTime.toFixed(1)}s
              </div>
              <div className="phrase-info">
                <div className="phrase-scores">
                  <div className="phrase-score-item">
                    <span className="phrase-label">🎵 音准</span>
                    <span className={phrase.pitch >= 90 ? 'phrase-score-high' : phrase.pitch >= 80 ? 'phrase-score-good' : 'phrase-score-low'}>
                      {Math.round(phrase.pitch)}
                    </span>
                  </div>
                  <div className="phrase-score-item">
                    <span className="phrase-label">🥁 节奏</span>
                    <span className={phrase.rhythm >= 90 ? 'phrase-score-high' : phrase.rhythm >= 80 ? 'phrase-score-good' : 'phrase-score-low'}>
                      {Math.round(phrase.rhythm)}
                    </span>
                  </div>
                  <div className="phrase-score-item">
                    <span className="phrase-label">❤️ 情绪</span>
                    <span className={phrase.emotion >= 90 ? 'phrase-score-high' : phrase.emotion >= 80 ? 'phrase-score-good' : 'phrase-score-low'}>
                      {Math.round(phrase.emotion)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    ) : null;

    const card = (
      <div key={data.students.length} className="student-card" style={{ borderLeftColor: color }}>
        <div className="card-top">
          <div className="stu-name">{name} <span className="rank-badge" style={{ background: color }}>{rank}</span></div>
          <div className="stu-total" style={{ color: color }}>{total}</div>
        </div>
        <div className="dim-bars">
          <div className="dim-row">
            <span className="dim-label">音准</span>
            <div className="dim-track"><div className="dim-fill" style={{ width: `${p}%`, background: '#30d158' }}></div></div>
            <span className="dim-score">{p}</span>
          </div>
          <div className="dim-row">
            <span className="dim-label">节奏</span>
            <div className="dim-track"><div className="dim-fill" style={{ width: `${r}%`, background: '#0a84ff' }}></div></div>
            <span className="dim-score">{r}</span>
          </div>
          <div className="dim-row">
            <span className="dim-label">情绪</span>
            <div className="dim-track"><div className="dim-fill" style={{ width: `${e}%`, background: '#ffd60a' }}></div></div>
            <span className="dim-score">{e}</span>
          </div>
        </div>
        <div className="pro-comment">
          <div className="comment-item"><span className="c-label">🎵 音准:</span><span>{comments.pitch}</span></div>
          <div className="comment-item"><span className="c-label">🥁 节奏:</span><span>{comments.rhythm}</span></div>
          <div className="comment-item"><span className="c-label">❤️ 情绪:</span><span>{comments.emotion}</span></div>
        </div>
        {phraseDetails}
        <audio controls src={URL.createObjectURL(blob)} />
      </div>
    );

    setStudentCards(prev => [card, ...prev]);
    
    // 保存评分数据用于分享
    const scoreData: StudentScoreData = {
      name,
      total,
      pitch: p,
      rhythm: r,
      emotion: e,
      rank,
      rankColor: color,
      comments,
      phraseScores
    };
    setStudentScoreData(prev => [scoreData, ...prev]);
    
    data.students.push({ name });
    setUpdateCounter(prev => prev + 1);
  };

  const resetClassroom = () => {
    if (!confirm('确定要清空记录吗？')) return;
    const data = appDataRef.current;
    data.students = [];
    data.stats = {
      frames: 0,
      hits: 0,
      diffSum: 0,
      teacherEnergy: [],
      studentVol: [],
      sampleData: []
    };
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
  const audioBufferToWav = (buffer: AudioBuffer): Blob => {
    const numOfChan = buffer.numberOfChannels;
    const length = buffer.length * numOfChan * 2 + 44;
    const bufferArray = new ArrayBuffer(length);
    const view = new DataView(bufferArray);
    const channels = [];
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
    setUint32(view, buffer.sampleRate, pos); pos += 4; // sample rate
    setUint32(view, buffer.sampleRate * 2 * numOfChan, pos); pos += 4; // avg. bytes/sec
    setUint16(view, numOfChan * 2, pos); pos += 2; // block-align
    setUint16(view, 16, pos); pos += 2; // 16-bit
    setUint32(view, 0x61746164, pos); pos += 4; // "data" chunk
    setUint32(view, length - pos - 4, pos); pos += 4;
    
    // 获取通道数据
    for (let i = 0; i < buffer.numberOfChannels; i++) {
      channels.push(buffer.getChannelData(i));
    }
    
    // 写入音频数据
    while (pos < length) {
      for (let i = 0; i < numOfChan; i++) {
        sample = Math.max(-1, Math.min(1, channels[i][offset]));
        sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(pos, sample, true);
        pos += 2;
      }
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
          
          // 重新生成学生卡片
          const newCards: React.ReactElement[] = [];
          const data = appDataRef.current;
          
          for (const score of scores) {
            // 生成歌曲得分明细UI
            const phraseDetails = score.phraseScores && score.phraseScores.length > 0 ? (
              <div className="phrase-details mt-3">
                <div className="phrase-details-header">
                  <span>📊 歌曲得分明细</span>
                  <span style={{ marginLeft: 'auto', fontSize: '11px', fontWeight: 'normal' }}>
                    共 {score.phraseScores.length} 个片段
                  </span>
                </div>
                <div className="phrase-details-content">
                  {score.phraseScores.map((phrase: PhraseScore) => (
                    <div key={phrase.id} className="phrase-item">
                      <div className="phrase-time-badge">
                        {phrase.startTime.toFixed(1)}s-{phrase.endTime.toFixed(1)}s
                      </div>
                      <div className="phrase-info">
                        <div className="phrase-scores">
                          <div className="phrase-score-item">
                            <span className="phrase-label">🎵 音准</span>
                            <span className={phrase.pitch >= 90 ? 'phrase-score-high' : phrase.pitch >= 80 ? 'phrase-score-good' : 'phrase-score-low'}>
                              {Math.round(phrase.pitch)}
                            </span>
                          </div>
                          <div className="phrase-score-item">
                            <span className="phrase-label">🥁 节奏</span>
                            <span className={phrase.rhythm >= 90 ? 'phrase-score-high' : phrase.rhythm >= 80 ? 'phrase-score-good' : 'phrase-score-low'}>
                              {Math.round(phrase.rhythm)}
                            </span>
                          </div>
                          <div className="phrase-score-item">
                            <span className="phrase-label">❤️ 情绪</span>
                            <span className={phrase.emotion >= 90 ? 'phrase-score-high' : phrase.emotion >= 80 ? 'phrase-score-good' : 'phrase-score-low'}>
                              {Math.round(phrase.emotion)}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null;
            
            const card = (
              <div key={newCards.length} className="student-card" style={{ borderLeftColor: score.rankColor }}>
                <div className="card-top">
                  <div className="stu-name">{score.name} <span className="rank-badge" style={{ background: score.rankColor }}>{score.rank}</span></div>
                  <div className="stu-total" style={{ color: score.rankColor }}>{score.total}</div>
                </div>
                <div className="dim-bars">
                  <div className="dim-row">
                    <span className="dim-label">音准</span>
                    <div className="dim-track"><div className="dim-fill" style={{ width: `${score.pitch}%`, background: '#30d158' }}></div></div>
                    <span className="dim-score">{score.pitch}</span>
                  </div>
                  <div className="dim-row">
                    <span className="dim-label">节奏</span>
                    <div className="dim-track"><div className="dim-fill" style={{ width: `${score.rhythm}%`, background: '#0a84ff' }}></div></div>
                    <span className="dim-score">{score.rhythm}</span>
                  </div>
                  <div className="dim-row">
                    <span className="dim-label">情绪</span>
                    <div className="dim-track"><div className="dim-fill" style={{ width: `${score.emotion}%`, background: '#ffd60a' }}></div></div>
                    <span className="dim-score">{score.emotion}</span>
                  </div>
                </div>
                <div className="pro-comment">
                  <div className="comment-item"><span className="c-label">🎵 音准:</span><span>{score.comments.pitch}</span></div>
                  <div className="comment-item"><span className="c-label">🥁 节奏:</span><span>{score.comments.rhythm}</span></div>
                  <div className="comment-item"><span className="c-label">❤️ 情绪:</span><span>{score.comments.emotion}</span></div>
                </div>
                {phraseDetails}
                {score.audioUrl && <audio controls src={score.audioUrl} />}
              </div>
            );
            
            newCards.push(card);
            data.students.push({ name: score.name });
          }
          
          setStudentCards(newCards);
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
    
    if (!hasVoice && !hasStudents) {
      alert('请先上传干声或进行演唱评测');
      return;
    }
    
    setShareLoading(true);
    setLoading(true);
    setLoadingText('正在准备分享数据...');
    
    try {
      // 1. 上传干声文件（如果有录制数据）
      let voiceUrl = null;
      const chunks = appDataRef.current.chunks;
      if (chunks && chunks.length > 0) {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const file = new File([blob], 'voice.webm', { type: 'audio/webm' });
        
        const formData = new FormData();
        formData.append('file', file);
        formData.append('type', 'voice');
        
        const uploadResponse = await fetch('/api/upload', {
          method: 'POST',
          body: formData
        });
        
        const uploadResult = await uploadResponse.json();
        if (uploadResult.success) {
          voiceUrl = uploadResult.url;
        }
      }
      
      // 2. 如果没有录制数据，使用上传的干声
      if (!voiceUrl) {
        const refInput = fileRefRef.current;
        if (refInput && refInput.files && refInput.files[0]) {
          const formData = new FormData();
          formData.append('file', refInput.files[0]);
          formData.append('type', 'voice');
          
          const uploadResponse = await fetch('/api/upload', {
            method: 'POST',
            body: formData
          });
          
          const uploadResult = await uploadResponse.json();
          if (uploadResult.success) {
            voiceUrl = uploadResult.url;
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
      
      // 3. 上传伴奏（如果有）
      let accompanimentUrl = null;
      const accInput = fileAccRef.current;
      if (accInput && accInput.files && accInput.files[0]) {
        const formData = new FormData();
        formData.append('file', accInput.files[0]);
        formData.append('type', 'accompaniment');
        
        const uploadResponse = await fetch('/api/upload', {
          method: 'POST',
          body: formData
        });
        
        const uploadResult = await uploadResponse.json();
        if (uploadResult.success) {
          accompanimentUrl = uploadResult.url;
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
        
        const uploadResult = await uploadResponse.json();
        if (uploadResult.success) {
          scoreImageUrl = uploadResult.url;
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
      
      const shareResult = await shareResponse.json();
      
      if (shareResult.success) {
        // 使用当前域名拼接完整URL
        const fullShareUrl = `${window.location.origin}/?share=${shareResult.shareId}`;
        setShareUrl(fullShareUrl);
        // 复制到剪贴板
        try {
          await navigator.clipboard.writeText(fullShareUrl);
          alert('分享链接已复制到剪贴板！');
        } catch {
          alert(`分享链接：${fullShareUrl}`);
        }
      } else {
        alert('创建分享链接失败');
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
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    }
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

  return (
    <div className="flex h-screen overflow-hidden bg-[#121214] text-[#e0e0e0]">
      {/* Loading Overlay */}
      {loading && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 backdrop-blur-sm">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-[#333] border-t-[#0a84ff]"></div>
          <div className="mt-5 text-base font-bold text-white">{loadingText}</div>
        </div>
      )}

      {/* 左侧：课堂记录 */}
      <div className="flex h-full w-[320px] shrink-0 flex-col border-r border-[#333] bg-[#18181a]">
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
            disabled={students.length === 0}
            className="w-full rounded-lg border-none bg-[#0a84ff] py-3 text-[14px] text-white cursor-pointer hover:bg-[#0070e0] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            🔗 分享课堂
          </button>
          <button
            onClick={resetClassroom}
            className="w-full rounded-lg border-none bg-[#333] py-3 text-[14px] text-[#aaa] cursor-pointer hover:bg-[#444] transition-colors"
          >
            🔄 重置课堂
          </button>
        </div>
      </div>

      {/* 中间：主控台 */}
      <div className="flex flex-1 flex-col items-center overflow-y-auto p-5 border-r border-[#333]">
        <div className="w-full max-w-[1200px] rounded-2xl bg-[#1e1e20] p-5 shadow-[0_10px_40px_rgba(0,0,0,0.4)] border border-[#333]">
          <h2 className="mb-5 flex items-center justify-between text-lg">
            <span>🎹 智能声乐评测 <span style={{ fontSize: '12px', background: '#333', padding: '2px 6px', borderRadius: '4px', color: '#aaa' }}>V9.0 细化版</span></span>
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
            <canvas ref={canvasRef} className="block h-full w-full" />
            <div className="absolute right-[15px] top-[15px] text-right pointer-events-none">
              <div className="text-[32px] font-black text-[#30d158] transition-colors" id="realtimeScore">
                {realtimeScore}
              </div>
              <div className="mt-[5px] text-[14px] text-[#aaa]">{realtimeStatus}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-[15px]">
            <button
              onClick={startSession}
              disabled={!refBuffer || students.length >= 4}
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

      {/* 右侧：乐谱视窗 */}
      <div className="flex h-full w-[600px] shrink-0 flex-col bg-[#151517]">
        <div className="border-b border-[#333] bg-[#1c1c1f] px-8 py-[15px] flex items-center justify-between">
          <span className="font-bold text-lg">🎼 乐谱视窗</span>
          <span className="text-[12px] text-[#666]">支持滚动查看</span>
        </div>
        <div className="flex-1 overflow-y-auto p-[25px]" style={{ backgroundImage: 'radial-gradient(#222 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
          {scoreImage ? (
            <img src={scoreImage} alt="Sheet Music" className="w-full rounded-lg shadow-[0_4px_10px_rgba(0,0,0,0.5)]" />
          ) : (
            <div className="mt-[50%] text-center text-[#555] -translate-y-1/2">
              未上传乐谱<br />
              <span className="text-[12px] text-[#444]">请点击"3. 乐谱"加载图片</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
