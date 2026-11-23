'use client';

import { useRef, useEffect, useState, useMemo } from 'react';

interface SampleData {
  time: number;
  volume: number;
  hasPitch: boolean;
  isHit: boolean;
  pitchDiff?: number;
  midi?: number;
}

interface MelodyPoint {
  time: number;
  midi: number;
  vol: number;
}

interface SingingPortraitProps {
  sampleData: SampleData[];
  melodyData: MelodyPoint[];
  tolerance: number;
  studentName: string;
}

// MIDI 转音符名称
const midiToNoteName = (midi: number): string => {
  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(midi / 12) - 1;
  const note = noteNames[midi % 12];
  return `${note}${octave}`;
};

export default function SingingPortrait({ sampleData, melodyData, tolerance, studentName }: SingingPortraitProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasHeight, setCanvasHeight] = useState(300);

  // 宽度随歌曲时长动态计算（每秒 50px，超出可横向滚动）
  // 宽度安全上限：backing store = 宽 × DPR(上限1.5)，需低于老显卡 8192 纹理上限
  // 5400 × 1.5 = 8100 < 8192，约 108 秒内仍保持 50px/秒的舒展比例
  const canvasWidth = useMemo(() => {
    if (!sampleData || sampleData.length === 0) return 800;
    const maxTime = Math.max(
      ...sampleData.map(s => s.time),
      ...melodyData.map(m => m.time)
    );
    return Math.min(5400, Math.max(800, maxTime * 50));
  }, [sampleData, melodyData]);

  // 高度跟随容器，填满所在区域（监听容器尺寸变化）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateHeight = () => {
      const h = container.clientHeight;
      if (h > 0) setCanvasHeight(h);
    };

    // 初次测量异步执行，避免在 effect 体内同步 setState
    const rafId = requestAnimationFrame(updateHeight);

    // 旧浏览器内核（如老 Edge/嵌入式浏览器）不支持 ResizeObserver 时降级为监听窗口缩放
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateHeight);
      observer.observe(container);
      return () => {
        cancelAnimationFrame(rafId);
        observer.disconnect();
      };
    }

    window.addEventListener('resize', updateHeight);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', updateHeight);
    };
  }, []);

  // 绘制画像
  useEffect(() => {
    if (!canvasRef.current || !sampleData || sampleData.length === 0) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 设置 canvas 尺寸 - 使用动态宽高
    // 像素比上限 1.5：避免高分屏(4K/缩放)下 backing store 超过老核显 GPU 纹理上限导致画布空白
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = canvasWidth;
    const height = canvasHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // 清空画布
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    // 边距 - 增加左侧边距以容纳标签
    const padding = { top: 30, right: 20, bottom: 40, left: 60 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;

    // 计算时间范围
    const allTimes = [
      ...sampleData.map(s => s.time),
      ...melodyData.map(m => m.time)
    ];
    const minTime = Math.min(...allTimes);
    const maxTime = Math.max(...allTimes);
    const timeRange = maxTime - minTime || 1;

    // 计算 MIDI 范围
    const allMidis = [
      ...sampleData.filter(s => s.midi).map(s => s.midi!),
      ...melodyData.map(m => m.midi)
    ];
    const minMidi = Math.min(...allMidis) - 1;
    const maxMidi = Math.max(...allMidis) + 1;
    const midiRange = maxMidi - minMidi || 1;

    // 坐标转换函数
    const timeToX = (time: number) => padding.left + ((time - minTime) / timeRange) * plotWidth;
    const midiToY = (midi: number) => padding.top + plotHeight - ((midi - minMidi) / midiRange) * plotHeight;

    // 绘制网格
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 0.5;

    // 根据 canvas 高度动态计算标签间隔
    const minLabelSpacing = 20;
    const maxLabels = Math.floor(plotHeight / minLabelSpacing);
    const labelInterval = Math.max(1, Math.ceil(midiRange / maxLabels));

    // 水平网格线（MIDI）
    const gridInterval = Math.max(1, Math.ceil(midiRange / (plotHeight / 10)));
    for (let midi = Math.ceil(minMidi); midi <= maxMidi; midi += gridInterval) {
      const y = midiToY(midi);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
    }

    // 标注音符名称
    ctx.fillStyle = '#888';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    for (let midi = Math.ceil(minMidi); midi <= maxMidi; midi += labelInterval) {
      const y = midiToY(midi);
      ctx.fillText(midiToNoteName(midi), padding.left - 8, y + 4);
    }

    // 垂直网格线（时间）- 根据宽度调整间隔
    const timeStep = timeRange > 120 ? 30 : timeRange > 60 ? 15 : timeRange > 30 ? 10 : timeRange > 10 ? 5 : 2;
    for (let t = Math.ceil(minTime / timeStep) * timeStep; t <= maxTime; t += timeStep) {
      const x = timeToX(t);
      ctx.beginPath();
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, height - padding.bottom);
      ctx.stroke();

      // 标注时间
      ctx.fillStyle = '#888';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${t}s`, x, height - padding.bottom + 18);
    }

    // 绘制容错区域
    ctx.fillStyle = 'rgba(48, 209, 88, 0.1)';
    for (let i = 0; i < melodyData.length - 1; i++) {
      const m1 = melodyData[i];
      const m2 = melodyData[i + 1];

      const x1 = timeToX(m1.time);
      const x2 = timeToX(m2.time);
      const yTop = midiToY(m1.midi + tolerance);
      const yBottom = midiToY(m1.midi - tolerance);

      ctx.fillRect(x1, yTop, x2 - x1, yBottom - yTop);
    }

    // 绘制标准旋律
    ctx.strokeStyle = '#007aff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    let started = false;
    for (const point of melodyData) {
      const x = timeToX(point.time);
      const y = midiToY(point.midi);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // 绘制标准旋律点
    ctx.fillStyle = '#007aff';
    for (const point of melodyData) {
      const x = timeToX(point.time);
      const y = midiToY(point.midi);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // 绘制学生演唱轨迹
    ctx.lineWidth = 2;
    for (let i = 0; i < sampleData.length - 1; i++) {
      const s1 = sampleData[i];
      const s2 = sampleData[i + 1];

      if (!s1.midi || !s2.midi) continue;

      const x1 = timeToX(s1.time);
      const y1 = midiToY(s1.midi);
      const x2 = timeToX(s2.time);
      const y2 = midiToY(s2.midi);

      ctx.strokeStyle = s1.isHit ? '#30d158' : '#ff453a';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // 绘制学生演唱点
    for (const sample of sampleData) {
      if (!sample.midi) continue;
      const x = timeToX(sample.time);
      const y = midiToY(sample.midi);

      ctx.fillStyle = sample.isHit ? '#30d158' : '#ff453a';
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }

    // 绘制图例
    const legendY = 12;
    ctx.font = '12px sans-serif';

    ctx.fillStyle = '#007aff';
    ctx.fillRect(padding.left, legendY, 20, 3);
    ctx.fillStyle = '#ccc';
    ctx.textAlign = 'left';
    ctx.fillText('标准旋律', padding.left + 25, legendY + 5);

    ctx.fillStyle = '#30d158';
    ctx.beginPath();
    ctx.arc(padding.left + 120, legendY + 2, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ccc';
    ctx.fillText('命中', padding.left + 130, legendY + 5);

    ctx.fillStyle = '#ff453a';
    ctx.beginPath();
    ctx.arc(padding.left + 180, legendY + 2, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ccc';
    ctx.fillText('偏离', padding.left + 190, legendY + 5);

    ctx.fillStyle = 'rgba(48, 209, 88, 0.3)';
    ctx.fillRect(padding.left + 240, legendY - 2, 15, 8);
    ctx.fillStyle = '#ccc';
    ctx.fillText('容错', padding.left + 260, legendY + 5);

  }, [sampleData, melodyData, tolerance, canvasWidth, canvasHeight]);

  if (!sampleData || sampleData.length === 0) {
    return null;
  }

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col">
      <div className="mb-2 shrink-0 text-xs text-gray-400">
        {studentName} 的演唱轨迹 vs 标准旋律
      </div>
      {/* 可横向滚动画布容器（min-w-0 防止超宽画布撑爆布局） */}
      <div
        ref={containerRef}
        className="min-h-0 min-w-0 w-full flex-1 overflow-x-auto overflow-y-hidden rounded-lg border border-gray-700"
      >
        <canvas
          ref={canvasRef}
          style={{
            width: `${canvasWidth}px`,
            height: `${canvasHeight}px`,
            display: 'block'
          }}
        />
      </div>
      <div className="mt-2 shrink-0 text-[10px] text-gray-500 flex flex-wrap gap-3">
        <span>🟢 命中标准音</span>
        <span>🔴 偏离标准音</span>
        <span>🔵 标准旋律</span>
        <span>🟩 容错范围</span>
        <span className="text-gray-600">← 可左右滚动查看完整轨迹 →</span>
      </div>
    </div>
  );
}
