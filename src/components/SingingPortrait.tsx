'use client';

import { useRef, useEffect, useState } from 'react';

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
  const [expanded, setExpanded] = useState(false);
  const [canvasWidth, setCanvasWidth] = useState(800);

  // 计算动态宽度
  useEffect(() => {
    if (!sampleData || sampleData.length === 0) return;
    
    const allTimes = [
      ...sampleData.map(s => s.time),
      ...melodyData.map(m => m.time)
    ];
    const maxTime = Math.max(...allTimes);
    
    // 每秒 50px，确保数据点有足够空间
    const pixelsPerSecond = 50;
    const minWidth = 800;
    const calculatedWidth = Math.max(minWidth, maxTime * pixelsPerSecond);
    setCanvasWidth(calculatedWidth);
  }, [sampleData, melodyData]);

  useEffect(() => {
    if (!expanded || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 设置 canvas 尺寸 - 使用动态宽度
    const dpr = window.devicePixelRatio || 1;
    const height = 300;
    canvas.width = canvasWidth * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const width = canvasWidth;

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

  }, [expanded, sampleData, melodyData, tolerance, canvasWidth]);

  if (!sampleData || sampleData.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 border-t border-gray-700 pt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-blue-400 hover:text-blue-300 transition-colors"
      >
        <span className={`transform transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
        <span>🎼 演唱画像</span>
      </button>

      {expanded && (
        <div className="mt-2">
          <div className="text-xs text-gray-400 mb-2">
            {studentName} 的演唱轨迹 vs 标准旋律
          </div>
          {/* 可滚动容器 */}
          <div 
            ref={containerRef}
            className="overflow-x-auto rounded-lg border border-gray-700"
            style={{ maxWidth: '100%' }}
          >
            <canvas
              ref={canvasRef}
              style={{ 
                width: `${canvasWidth}px`, 
                height: '300px',
                display: 'block'
              }}
            />
          </div>
          <div className="mt-2 text-[10px] text-gray-500 flex flex-wrap gap-3">
            <span>🟢 命中标准音</span>
            <span>🔴 偏离标准音</span>
            <span>🔵 标准旋律</span>
            <span>🟩 容错范围</span>
            <span className="text-gray-600">← 可左右滚动查看完整轨迹 →</span>
          </div>
        </div>
      )}
    </div>
  );
}
