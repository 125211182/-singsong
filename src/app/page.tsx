'use client';

import { useEffect, useRef, useState } from 'react';

// ================= 配置 (V8.0 暖心版参数) =================
const CONFIG = {
  scrollSpeed: 100,
  analyzePrecision: 0.05,
  tolerance: 2.5, // 宽松容错
  minVol: 0.02
};

// ================= 类型定义 =================
interface MelodyPoint {
  time: number;
  midi: number;
}

interface Student {
  name: string;
}

interface ScoreComments {
  pitch: string;
  rhythm: string;
  emotion: string;
}

// ================= 全局状态 =================
interface AppState {
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
  };
  currentSource: AudioBufferSourceNode | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  students: Student[];
  scoreImage: string | null;
}

export default function Home() {
  // Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRefRef = useRef<HTMLInputElement>(null);
  const fileAccRef = useRef<HTMLInputElement>(null);
  const fileScoreRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  // State
  const [app, setApp] = useState<AppState>({
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
      studentVol: []
    },
    currentSource: null,
    recorder: null,
    chunks: [],
    students: [],
    scoreImage: null
  });

  const [realtimeScore, setRealtimeScore] = useState('--');
  const [realtimeStatus, setRealtimeStatus] = useState('Ready');
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState('Processing...');
  const [studentCards, setStudentCards] = useState<React.ReactElement[]>([]);

  // ================= 1. 文件上传处理 =================
  const handleRefUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    showLoading(true, '正在分析旋律...');
    try {
      const arrayBuffer = await file.arrayBuffer();
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const buffer = await ctx.decodeAudioData(arrayBuffer);

      // 提取旋律数据 (简化版：使用 RMS 能量峰值)
      const melodyData = extractMelodyFromBuffer(buffer, ctx);

      setApp(prev => ({
        ...prev,
        ctx,
        refBuffer: buffer,
        melodyData,
        students: [],
        stats: {
          frames: 0,
          hits: 0,
          diffSum: 0,
          teacherEnergy: [],
          studentVol: []
        }
      }));
      setStudentCards([]);
      updateUIState();
    } catch (err) {
      console.error('解析失败:', err);
      alert('音频解析失败，请重试');
    }
    showLoading(false);
  };

  const handleAccUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    showLoading(true, '正在加载伴奏...');
    try {
      const arrayBuffer = await file.arrayBuffer();
      const ctx = app.ctx || new (window.AudioContext || (window as any).webkitAudioContext)();
      const buffer = await ctx.decodeAudioData(arrayBuffer);

      setApp(prev => ({
        ...prev,
        ctx,
        accBuffer: buffer
      }));
      updateUIState();
    } catch (err) {
      console.error('加载伴奏失败:', err);
      alert('伴奏加载失败，请重试');
    }
    showLoading(false);
  };

  const handleScoreUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      setApp(prev => ({
        ...prev,
        scoreImage: e.target?.result as string
      }));
    };
    reader.readAsDataURL(file);
  };

  // ================= 2. 旋律提取 (简化版) =================
  const extractMelodyFromBuffer = (buffer: AudioBuffer, ctx: AudioContext): MelodyPoint[] => {
    const melody: MelodyPoint[] = [];
    const channelData = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;
    const hopSize = Math.floor(sampleRate * 0.05); // 每 50ms 分析一次

    for (let i = 0; i < channelData.length; i += hopSize) {
      // 简化版：使用能量和音高估算
      const segment = channelData.slice(i, Math.min(i + hopSize, channelData.length));
      const rms = calculateRMS(segment);
      const freq = calculateFrequency(segment, sampleRate);

      if (rms > 0.01 && freq !== null && freq > 60) {
        const midi = 69 + 12 * Math.log2(freq / 440);
        melody.push({
          time: i / sampleRate,
          midi: Math.round(midi)
        });
      }
    }

    return melody;
  };

  const calculateRMS = (data: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i] * data[i];
    }
    return Math.sqrt(sum / data.length);
  };

  const calculateFrequency = (data: Float32Array, sampleRate: number): number | null => {
    const rms = calculateRMS(data);
    if (rms < 0.01) return null;

    // 简化的自相关算法
    let size = data.length;
    let bestOffset = -1;
    let bestCorrelation = 0;
    let rms2 = 0;

    for (let i = 0; i < size; i++) {
      rms2 += data[i] * data[i];
    }
    rms2 = Math.sqrt(rms2 / size);

    if (rms2 < 0.01) return null;

    let lastCorrelation = 1;
    for (let offset = 1; offset < size; offset++) {
      let correlation = 0;
      for (let i = 0; i < size - offset; i++) {
        correlation += Math.abs((data[i] - rms2) * (data[i + offset] - rms2));
      }
      correlation = 1 - correlation / (size * rms2 * rms2);

      if (correlation > 0.9 && correlation > lastCorrelation) {
        const foundCorrelation = correlation;
        if (foundCorrelation > bestCorrelation) {
          bestCorrelation = foundCorrelation;
          bestOffset = offset;
        }
      }
      lastCorrelation = correlation;
    }

    if (bestOffset === -1) return null;
    return sampleRate / bestOffset;
  };

  // ================= 3. 开始/结束评测 =================
  const startSession = async () => {
    if (!app.ctx || !app.refBuffer) return;

    showLoading(true, '正在启动...');
    try {
      // 获取麦克风流
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = app.ctx.createMediaStreamSource(stream);
      const analyser = app.ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      // 录制音频
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);

      // 播放参考音频
      const refSource = app.ctx.createBufferSource();
      refSource.buffer = app.refBuffer;
      const refGain = app.ctx.createGain();
      refGain.gain.value = 0.3;
      refSource.connect(refGain);
      refGain.connect(analyser);
      refGain.connect(app.ctx.destination);
      refSource.start(0);

      setApp(prev => ({
        ...prev,
        isPlaying: true,
        startTime: app.ctx!.currentTime,
        analyser,
        recorder,
        chunks,
        currentSource: refSource,
        stats: {
          frames: 0,
          hits: 0,
          diffSum: 0,
          teacherEnergy: [],
          studentVol: []
        }
      }));

      updateUIState();
      drawLoop();
    } catch (err) {
      console.error('启动失败:', err);
      alert('启动失败，请检查麦克风权限');
    }
    showLoading(false);
  };

  const stopSession = () => {
    if (!app.isPlaying) return;

    if (app.currentSource) app.currentSource.stop();
    if (app.recorder && app.recorder.state !== 'inactive') {
      app.recorder.stop();
      app.recorder.onstop = () => {
        const blob = new Blob(app.chunks, { type: 'audio/webm' });
        calculateBalancedScore(blob);
        setApp(prev => ({ ...prev, isPlaying: false }));
        updateUIState();
        setRealtimeStatus('Finished');
      };
    }

    setApp(prev => ({ ...prev, isPlaying: false }));
    updateUIState();
  };

  // ================= 4. 实时绘制 =================
  const drawLoop = () => {
    if (!app.isPlaying || !app.analyser) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const now = app.ctx!.currentTime - app.startTime;

    // 清空画布
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    // 绘制波形
    const wave = new Uint8Array(app.analyser.frequencyBinCount);
    app.analyser.getByteTimeDomainData(wave);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(10, 132, 255, 0.3)';
    ctx.beginPath();
    let slice = w / wave.length;
    let x = 0;
    for (let i = 0; i < wave.length; i += 4) {
      let v = wave[i] / 128.0;
      let y = v * h * 0.8;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += slice * 4;
    }
    ctx.stroke();

    // 绘制参考音符
    const centerX = w / 3;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    let currentNote: MelodyPoint | undefined;

    const melodyData: MelodyPoint[] = app.melodyData;
    for (let i = 0; i < melodyData.length; i++) {
      const p = melodyData[i];
      const x = centerX + (p.time - now) * CONFIG.scrollSpeed;
      if (x > -10 && x < w) {
        const y = getMidiY(p.midi, h);
        ctx.fillRect(x, y - 3, 4, 6);
        if (Math.abs(x - centerX) < 5) currentNote = p;
      }
    }

    // 分析用户音高
    const buffer = new Float32Array(2048);
    app.analyser.getFloatTimeDomainData(buffer);
    const rms = calculateRMS(buffer);
    const freq = calculateFrequency(buffer, app.ctx!.sampleRate);

    if (rms > 0.01) {
      setApp(prev => {
        const newStudentVol = [...prev.stats.studentVol, rms];
        return {
          ...prev,
          stats: { ...prev.stats, studentVol: newStudentVol }
        };
      });

      if (currentNote) {
        setApp(prev => ({
          ...prev,
          stats: { ...prev.stats, frames: prev.stats.frames + 1 }
        }));
      }

      if (freq && freq > 60) {
        let userMidi = 69 + 12 * Math.log2(freq / 440);
        let displayMidi = userMidi;
        let isHit = false;

        if (currentNote) {
          const diff = currentNote.midi - userMidi;
          const octOffset = 12 * Math.round(diff / 12);
          const normDiff = Math.abs(currentNote.midi - (userMidi + octOffset));

          setApp(prev => ({
            ...prev,
            stats: { ...prev.stats, diffSum: prev.stats.diffSum + normDiff }
          }));

          displayMidi = userMidi + octOffset;

          if (normDiff < CONFIG.tolerance) {
            isHit = true;
            setApp(prev => ({
              ...prev,
              stats: { ...prev.stats, hits: prev.stats.hits + 1 }
            }));
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
      } else {
        setRealtimeScore('...');
      }
    }

    // 绘制中心线
    ctx.beginPath();
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, h);
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([5, 5]);
    ctx.stroke();

    if (app.isPlaying) {
      requestAnimationFrame(drawLoop);
    }
  };

  const getMidiY = (midi: number, h: number): number => {
    return h - ((midi - 45) / (85 - 45)) * h;
  };

  // ================= 5. 评分算法 =================
  const calculateBalancedScore = (blob: Blob) => {
    const rawAccuracy = app.stats.frames > 0 ? app.stats.hits / app.stats.frames : 0;
    let scorePitch = 50 + Math.round(rawAccuracy * 50);
    const avgDiff = app.stats.frames > 0 ? app.stats.diffSum / app.stats.frames : 0;
    if (avgDiff > 1.5) scorePitch -= 5;
    scorePitch = Math.min(100, Math.round(scorePitch));

    const teacherTotal = app.melodyData.length;
    const coverage = teacherTotal > 0 ? app.stats.frames / teacherTotal : 0;
    const scoreRhythm = Math.min(100, Math.round((coverage / 0.8) * 100));

    const volMean = app.stats.studentVol.reduce((a, b) => a + b, 0) / (app.stats.studentVol.length || 1);
    const volVar = app.stats.studentVol.reduce((a, b) => a + Math.pow(b - volMean, 2), 0) / (app.stats.studentVol.length || 1);
    const scoreEmotion = Math.min(100, Math.round((Math.sqrt(volVar) / 0.02) * 40 + 60));

    let total = Math.round(scorePitch * 0.5 + scoreRhythm * 0.3 + scoreEmotion * 0.2);

    if (coverage > 0.6) total = Math.max(65, total);

    const comments = generateDetailedComments(scorePitch, scoreRhythm, scoreEmotion, total);
    addStudentCard(total, scorePitch, scoreRhythm, scoreEmotion, comments, blob);
  };

  const generateDetailedComments = (p: number, r: number, e: number, total: number): ScoreComments => {
    let cPitch, cRhythm, cEmotion;

    if (p >= 90) cPitch = "音高控制精准，核心音准非常稳定！";
    else if (p >= 80) cPitch = "大部分音都在调上，整体听感舒适。";
    else if (p >= 60) cPitch = "基础音准合格，注意长音的稳定性。";
    else cPitch = "音准有些浮动，建议多听范唱找准基频。";

    if (r >= 90) cRhythm = "节奏卡点精准，非常有乐感。";
    else if (r >= 70) cRhythm = "基本跟上了音乐骨架，完整度不错。";
    else cRhythm = "部分段落漏唱或拖拍，注意听鼓点。";

    if (e >= 85) cEmotion = "强弱对比鲜明，情感充沛！";
    else if (e >= 70) cEmotion = "声音平稳，再大胆一点会更好。";
    else cEmotion = "声音有点小，下次试试把声音放出来！";

    return { pitch: cPitch, rhythm: cRhythm, emotion: cEmotion };
  };

  const addStudentCard = (
    total: number,
    p: number,
    r: number,
    e: number,
    comments: ScoreComments,
    blob: Blob
  ) => {
    const name = `同学 ${String.fromCharCode(65 + app.students.length)}`;
    let rank = 'C';
    let color = '#ff453a';
    if (total >= 90) { rank = 'S'; color = '#ffd60a'; }
    else if (total >= 80) { rank = 'A'; color = '#30d158'; }
    else if (total >= 60) { rank = 'B'; color = '#0a84ff'; }

    const card = (
      <div key={app.students.length} className="student-card" style={{ borderLeftColor: color }}>
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
        <audio controls src={URL.createObjectURL(blob)} />
      </div>
    );

    setStudentCards(prev => [card, ...prev]);
    setApp(prev => ({
      ...prev,
      students: [...prev.students, { name }]
    }));
    updateUIState();
  };

  const resetClassroom = () => {
    setApp(prev => ({
      ...prev,
      students: [],
      stats: {
        frames: 0,
        hits: 0,
        diffSum: 0,
        teacherEnergy: [],
        studentVol: []
      }
    }));
    setStudentCards([]);
    updateUIState();
  };

  // ================= 工具函数 =================
  const showLoading = (show: boolean, text: string = 'Processing...') => {
    setLoading(show);
    setLoadingText(text);
  };

  const updateUIState = () => {
    // 更新UI状态
  };

  // ================= 初始化画布 =================
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    }
  }, []);

  return (
    <div className="flex min-h-screen bg-[#121214] text-[#e0e0e0]">
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
            <span className="text-[#0a84ff]">{app.students.length} / 4</span>
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
        <div className="border-t border-[#333] px-[15px] py-[15px]">
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
        <div className="w-full max-w-[600px] rounded-2xl bg-[#1e1e20] p-5 shadow-[0_10px_40px_rgba(0,0,0,0.4)] border border-[#333]">
          <h2 className="mb-5 flex items-center justify-between text-lg">
            <span>🎹 智能声乐评测 <span style={{ fontSize: '12px', background: '#333', padding: '2px 6px', borderRadius: '4px', color: '#aaa' }}>V8.2 Full</span></span>
            <span className="text-base font-bold text-[#0a84ff]">
              {app.refBuffer ? '准备就绪' : '等待文件'}
            </span>
          </h2>

          <div className="mb-5 grid grid-cols-3 gap-[10px]">
            <div
              onClick={() => fileRefRef.current?.click()}
              className={`track-slot ${app.refBuffer ? 'loaded' : ''}`}
            >
              <span className="icon-status">🗣️</span>
              <span className="slot-label">1. 干声(必选)</span>
              <span className="slot-desc">AI分析旋律</span>
            </div>
            <div
              onClick={() => fileAccRef.current?.click()}
              className={`track-slot ${app.accBuffer ? 'loaded' : ''}`}
            >
              <span className="icon-status">🎼</span>
              <span className="slot-label">2. 伴奏(可选)</span>
              <span className="slot-desc">背景播放</span>
            </div>
            <div
              onClick={() => fileScoreRef.current?.click()}
              className={`track-slot ${app.scoreImage ? 'loaded' : ''}`}
            >
              <span className="icon-status">📄</span>
              <span className="slot-label">3. 乐谱(可选)</span>
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
              disabled={!app.refBuffer || app.isPlaying}
              className="btn bg-gradient-to-br from-[#30d158] to-[#208a3a] text-black"
            >
              🎙️ 开始演唱
            </button>
            <button
              onClick={stopSession}
              disabled={!app.isPlaying}
              className="btn bg-[#ff453a] text-white"
            >
              ⏹ 结束评测
            </button>
          </div>
        </div>
      </div>

      {/* 右侧：乐谱视窗 */}
      <div className="flex h-full w-[400px] shrink-0 flex-col bg-[#151517]">
        <div className="border-b border-[#333] bg-[#1c1c1f] px-5 py-[15px] flex items-center justify-between">
          <span className="font-bold">🎼 乐谱视窗</span>
          <span className="text-[12px] text-[#666]">支持滚动查看</span>
        </div>
        <div className="flex-1 overflow-y-auto p-[10px]" style={{ backgroundImage: 'radial-gradient(#222 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
          {app.scoreImage ? (
            <img src={app.scoreImage} alt="Sheet Music" className="w-full rounded-lg shadow-[0_4px_10px_rgba(0,0,0,0.5)]" />
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
