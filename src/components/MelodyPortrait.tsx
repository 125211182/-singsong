'use client';

import { useRef, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Music, TrendingUp, TrendingDown } from 'lucide-react';

// 旋律点数据（标准旋律线）
interface MelodyPoint {
  time: number;
  midi: number;
}

// 采样点数据（学生演唱）
interface SampleData {
  time: number;
  volume: number;
  hasPitch: boolean;
  isHit: boolean;
  pitchDiff?: number;
  midi?: number;
}

interface MelodyPortraitProps {
  melodyData: MelodyPoint[];
  sampleData: SampleData[];
  totalDuration: number;
  studentName?: string;
}

// MIDI 转音符名称
function midiToNoteName(midi: number): string {
  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(midi / 12) - 1;
  const note = noteNames[midi % 12];
  return `${note}${octave}`;
}

// 获取 MIDI 音高的 Y 坐标
function getMidiY(midi: number, height: number, minMidi: number, maxMidi: number): number {
  const padding = 40;
  const usableHeight = height - padding * 2;
  const midiRange = maxMidi - minMidi || 1;
  return padding + usableHeight - ((midi - minMidi) / midiRange) * usableHeight;
}

export default function MelodyPortrait({ 
  melodyData, 
  sampleData, 
  totalDuration,
  studentName 
}: MelodyPortraitProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    y: number;
    time: number;
    refMidi: number | null;
    studentMidi: number | null;
    isHit: boolean;
  } | null>(null);

  // 计算 MIDI 范围
  const allMidis = [
    ...melodyData.map(p => p.midi),
    ...sampleData.filter(s => s.midi).map(s => s.midi!)
  ];
  const minMidi = Math.min(...allMidis) - 2;
  const maxMidi = Math.max(...allMidis) + 2;

  // 绘制旋律对比图
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !isExpanded) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const container = containerRef.current;
    if (!container) return;

    // 设置 canvas 尺寸
    const rect = container.getBoundingClientRect();
    const width = rect.width;
    const height = 300;
    canvas.width = width * 2; // 高清屏
    canvas.height = height * 2;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(2, 2);

    // 清空画布
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    // 绘制网格线
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    
    // 水平网格线（每个半音）
    for (let midi = minMidi; midi <= maxMidi; midi++) {
      const y = getMidiY(midi, height, minMidi, maxMidi);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();

      // 标注音符名称（仅整数 MIDI）
      if (midi % 12 === 0) { // 只标注 C 音
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.font = '10px system-ui';
        ctx.fillText(midiToNoteName(midi), 4, y - 4);
      }
    }

    // 垂直网格线（每秒）
    const timeScale = width / totalDuration;
    for (let t = 0; t <= totalDuration; t += 5) {
      const x = t * timeScale;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();

      // 标注时间
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.font = '10px system-ui';
      ctx.fillText(`${t}s`, x + 2, height - 4);
    }

    // 绘制标准旋律线（虚线，蓝色）
    if (melodyData.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = '#5DB7FF';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      
      melodyData.forEach((point, i) => {
        const x = point.time * timeScale;
        const y = getMidiY(point.midi, height, minMidi, maxMidi);
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 绘制学生演唱线（实线，绿色/红色）
    const studentPoints = sampleData.filter(s => s.midi);
    if (studentPoints.length > 1) {
      // 绘制连线
      ctx.lineWidth = 2;
      for (let i = 1; i < studentPoints.length; i++) {
        const prev = studentPoints[i - 1];
        const curr = studentPoints[i];
        
        const x1 = prev.time * timeScale;
        const y1 = getMidiY(prev.midi!, height, minMidi, maxMidi);
        const x2 = curr.time * timeScale;
        const y2 = getMidiY(curr.midi!, height, minMidi, maxMidi);

        ctx.beginPath();
        ctx.strokeStyle = curr.isHit ? '#77D982' : '#FF8FB3';
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      // 绘制采样点
      studentPoints.forEach(point => {
        const x = point.time * timeScale;
        const y = getMidiY(point.midi!, height, minMidi, maxMidi);
        
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = point.isHit ? '#77D982' : '#FF8FB3';
        ctx.fill();
      });
    }

    // 绘制图例
    const legendY = 20;
    ctx.font = '12px system-ui';
    
    // 标准旋律线图例
    ctx.strokeStyle = '#5DB7FF';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(width - 200, legendY);
    ctx.lineTo(width - 170, legendY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    ctx.fillText('标准旋律', width - 165, legendY + 4);

    // 学生演唱线图例
    ctx.strokeStyle = '#77D982';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(width - 100, legendY);
    ctx.lineTo(width - 70, legendY);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText('演唱准确', width - 65, legendY + 4);

    ctx.strokeStyle = '#FF8FB3';
    ctx.beginPath();
    ctx.moveTo(width - 100, legendY + 20);
    ctx.lineTo(width - 70, legendY + 20);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText('演唱偏离', width - 65, legendY + 24);

  }, [melodyData, sampleData, totalDuration, isExpanded, minMidi, maxMidi]);

  // 鼠标悬停事件
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const width = rect.width;
    const timeScale = width / totalDuration;
    const time = x / timeScale;

    // 找到最接近的采样点
    const closestSample = sampleData
      .filter(s => s.midi)
      .reduce((closest, curr) => {
        const currDist = Math.abs(curr.time - time);
        const closestDist = closest ? Math.abs(closest.time - time) : Infinity;
        return currDist < closestDist ? curr : closest;
      }, null as SampleData | null);

    // 找到最接近的参考点
    const closestRef = melodyData.reduce((closest, curr) => {
      const currDist = Math.abs(curr.time - time);
      const closestDist = closest ? Math.abs(closest.time - time) : Infinity;
      return currDist < closestDist ? curr : closest;
    }, null as MelodyPoint | null);

    if (closestSample && Math.abs(closestSample.time - time) < 0.5) {
      setHoverInfo({
        x,
        y,
        time: closestSample.time,
        refMidi: closestRef?.midi ?? null,
        studentMidi: closestSample.midi ?? null,
        isHit: closestSample.isHit
      });
    } else {
      setHoverInfo(null);
    }
  };

  // 统计信息
  const totalSamples = sampleData.filter(s => s.hasPitch).length;
  const hitSamples = sampleData.filter(s => s.isHit).length;
  const accuracyRate = totalSamples > 0 ? Math.round((hitSamples / totalSamples) * 100) : 0;

  if (sampleData.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 rounded-2xl bg-white/80 backdrop-blur-sm shadow-card overflow-hidden">
      {/* 标题栏 */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-primary/5 transition-colors"
        aria-label={isExpanded ? '收起演唱画像' : '展开演唱画像'}
      >
        <div className="flex items-center gap-2">
          <Music className="w-5 h-5 text-primary" />
          <span className="font-bold text-text">
            {studentName ? `${studentName} 的演唱画像` : '演唱画像'}
          </span>
          <span className="text-sm text-text/60 ml-2">
            准确率 {accuracyRate}%
          </span>
        </div>
        {isExpanded ? (
          <ChevronUp className="w-5 h-5 text-text/60" />
        ) : (
          <ChevronDown className="w-5 h-5 text-text/60" />
        )}
      </button>

      {/* 展开内容 */}
      {isExpanded && (
        <div ref={containerRef} className="px-4 pb-4">
          {/* 统计信息 */}
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="rounded-xl bg-primary/10 p-3 text-center">
              <div className="text-2xl font-bold text-primary">{totalSamples}</div>
              <div className="text-xs text-text/60">采样点数</div>
            </div>
            <div className="rounded-xl bg-success/10 p-3 text-center">
              <div className="text-2xl font-bold text-success">{hitSamples}</div>
              <div className="text-xs text-text/60">音准命中</div>
            </div>
            <div className="rounded-xl bg-error/10 p-3 text-center">
              <div className="text-2xl font-bold text-error">{totalSamples - hitSamples}</div>
              <div className="text-xs text-text/60">音准偏离</div>
            </div>
          </div>

          {/* Canvas 画布 */}
          <div className="relative rounded-xl overflow-hidden border border-border">
            <canvas
              ref={canvasRef}
              className="w-full cursor-crosshair"
              onMouseMove={handleMouseMove}
              onMouseLeave={() => setHoverInfo(null)}
            />
            
            {/* 悬停提示 */}
            {hoverInfo && (
              <div
                className="absolute pointer-events-none bg-black/80 text-white text-xs rounded-lg px-3 py-2 shadow-float"
                style={{
                  left: hoverInfo.x + 10,
                  top: hoverInfo.y - 60,
                }}
              >
                <div className="font-bold mb-1">时间: {hoverInfo.time.toFixed(2)}s</div>
                {hoverInfo.refMidi && (
                  <div>标准: {midiToNoteName(hoverInfo.refMidi)} (MIDI {hoverInfo.refMidi})</div>
                )}
                {hoverInfo.studentMidi && (
                  <div className={hoverInfo.isHit ? 'text-success' : 'text-error'}>
                    演唱: {midiToNoteName(hoverInfo.studentMidi)} (MIDI {hoverInfo.studentMidi})
                  </div>
                )}
                {hoverInfo.refMidi && hoverInfo.studentMidi && (
                  <div className="mt-1 flex items-center gap-1">
                    {hoverInfo.isHit ? (
                      <>
                        <TrendingUp className="w-3 h-3 text-success" />
                        <span className="text-success">音准命中</span>
                      </>
                    ) : (
                      <>
                        <TrendingDown className="w-3 h-3 text-error" />
                        <span className="text-error">
                          偏差: {Math.abs(hoverInfo.refMidi - hoverInfo.studentMidi).toFixed(1)} 半音
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 说明文字 */}
          <div className="mt-3 text-xs text-text/60 text-center">
            <span className="inline-block w-3 h-0.5 bg-primary mr-1 align-middle" style={{borderTop: '2px dashed #5DB7FF'}}></span>
            标准旋律线
            <span className="inline-block w-3 h-0.5 bg-success mx-1 align-middle"></span>
            演唱准确
            <span className="inline-block w-3 h-0.5 bg-error mx-1 align-middle"></span>
            演唱偏离
          </div>
        </div>
      )}
    </div>
  );
}
