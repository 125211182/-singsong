type PracticeScores = {
  pitch: number | null;
  rhythm: number | null;
  emotion: number | null;
};

const RANK_TIERS = [
  { min: 100, title: '天籁传奇' },
  { min: 97, title: '殿堂歌者' },
  { min: 94, title: '金牌唱将' },
  { min: 91, title: '舞台之星' },
  { min: 88, title: '实力唱将' },
  { min: 85, title: '闪耀新星' },
  { min: 82, title: '进阶达人' },
  { min: 79, title: '潜力唱将' },
  { min: 76, title: '稳定发挥' },
  { min: 73, title: '渐入佳境' },
  { min: 70, title: '稳步提升' },
  { min: 65, title: '崭露头角' },
  { min: 60, title: '勤学新星' },
  { min: 55, title: '勇敢开嗓' },
  { min: 0, title: '加油起步' },
];

const RANK_COLORS = [
  [0, 255, 107, 107],
  [55, 255, 69, 58],
  [62, 255, 159, 10],
  [70, 10, 132, 255],
  [82, 48, 209, 88],
  [94, 255, 214, 10],
  [100, 255, 233, 130],
] as const;

function getRankColor(total: number) {
  for (let index = 1; index < RANK_COLORS.length; index++) {
    const [end, endRed, endGreen, endBlue] = RANK_COLORS[index];
    if (total > end) continue;
    const [start, red, green, blue] = RANK_COLORS[index - 1];
    const mix = (total - start) / (end - start);
    const channel = (from: number, to: number) => Math.round(from + (to - from) * mix);
    return `rgb(${channel(red, endRed)}, ${channel(green, endGreen)}, ${channel(blue, endBlue)})`;
  }
  return '#0a84ff';
}

const PRACTICE_TIPS = {
  pitch: '下一遍先听一句范唱，再跟着唱一遍。',
  rhythm: '下一遍先拍一遍节拍，找准起唱位置。',
  emotion: '下一遍试试轻一点唱句尾，再回听这一句的强弱。',
} satisfies Record<keyof PracticeScores, string>;

function isPracticeScore(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function getSingingPracticeReward({ pitch, rhythm, emotion }: PracticeScores) {
  if (!isPracticeScore(pitch) || !isPracticeScore(rhythm) || !isPracticeScore(emotion)) {
    return {
      total: null,
      title: null,
      color: '#0a84ff',
      message: '已录下这次练唱。先回听一遍，如果人声不清楚，靠近麦克风试唱一句。',
    };
  }

  const total = Math.round(pitch * 0.5 + rhythm * 0.3 + emotion * 0.2);
  const rankIndex = RANK_TIERS.findIndex(tier => total >= tier.min);
  const { title } = RANK_TIERS[rankIndex];
  const nextRank = RANK_TIERS[rankIndex - 1];
  const weakest = Math.min(pitch, rhythm, emotion);
  const practiceTip = weakest === pitch ? PRACTICE_TIPS.pitch : weakest === rhythm ? PRACTICE_TIPS.rhythm : PRACTICE_TIPS.emotion;
  const message = nextRank
    ? `再得 ${nextRank.min - total} 分可获得「${nextRank.title}」。${practiceTip}`
    : '已获得最高称号。回听录音，找一句你想和同学分享的演唱。';
  return { total, title, color: getRankColor(total), message };
}
