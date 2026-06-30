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
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 设置 canvas 尺寸
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;

    // 清空画布
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    // 边距
    const padding = { top: 20, right: 20, bottom: 40, left: 50 };
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
    const minMidi = Math.min(...allMidis) - 2;
    const maxMidi = Math.max(...allMidis) + 2;
    const midiRange = maxMidi - minMidi || 1;

    // 坐标转换函数
    const timeToX = (time: number) => padding.left + ((time - minTime) / timeRange) * plotWidth;
    const midiToY = (midi: number) => padding.top + plotHeight - ((midi - minMidi) / midiRange) * plotHeight;

    // 绘制网格
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 0.5;

    // 水平网格线（MIDI）
    for (let midi = Math.ceil(minMidi); midi <= maxMidi; midi++) {
      const y = midiToY(midi);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      // 标注音符名称
      if (midi % 2 === 0) {
        ctx.fillStyle = '#888';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(midiToNoteName(midi), padding.left - 5, y + 3);
      }
    }

    // 垂直网格线（时间）
    const timeStep = timeRange > 30 ? 10 : timeRange > 10 ? 5 : 2;
    for (let t = Math.ceil(minTime / timeStep) * timeStep; t <= maxTime; t += timeStep) {
      const x = timeToX(t);
      ctx.beginPath();
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, height - padding.bottom);
      ctx.stroke();

      // 标注时间
      ctx.fillStyle = '#888';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${t}s`, x, height - padding.bottom + 15);
    }

    // 绘制容错区域（标准旋律上下 tolerance 个半音）
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
    ctx.lineWidth = 2;
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
      ctx.arc(x, y, 2, 0, Math.PI * 2);
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

      // 根据是否命中选择颜色
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
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // 绘制图例
    const legendY = 10;
    ctx.font = '11px sans-serif';
    
    // 标准旋律
    ctx.fillStyle = '#007aff';
    ctx.fillRect(padding.left, legendY, 15, 3);
    ctx.fillText('标准旋律', padding.left + 20, legendY + 5);

    // 学生演唱（命中）
    ctx.fillStyle = '#30d158';
    ctx.beginPath();
    ctx.arc(padding.left + 100, legendY + 2, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#aaa';
    ctx.fillText('命中', padding.left + 110, legendY + 5);

    // 学生演唱（偏离）
    ctx.fillStyle = '#ff453a';
    ctx.beginPath();
    ctx.arc(padding.left + 150, legendY + 2, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#aaa';
    ctx.fillText('偏离', padding.left + 160, legendY + 5);

  }, [expanded, sampleData, melodyData, tolerance]);

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
          <div className="text-[10px] text-gray-400 mb-1">
            {studentName} 的演唱轨迹 vs 标准旋律
          </div>
          <canvas
            ref={canvasRef}
            className="w-full rounded-lg"
            style={{ height: '200px' }}
          />
          <div className="mt-1 text-[9px] text-gray-500">
            绿色 = 命中标准音 | 红色 = 偏离 | 蓝色 = 标准旋律 | 绿色背景 = 容错范围
          </div>
        </div>
      )}
    </div>
  );
}
