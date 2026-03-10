/**
 * 分享API - 创建分享链接
 * POST /api/share
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { nanoid } from 'nanoid';

// 生成唯一分享ID
function generateShareId(): string {
  return nanoid(10);
}

export async function POST(request: NextRequest) {
  // 延迟初始化Supabase客户端
  const supabase = getSupabaseClient();
  try {
    const body = await request.json();
    const { 
      voiceUrl,      // 干声URL
      accompanimentUrl, // 伴奏URL  
      scoreImageUrl, // 乐谱图片URL
      scores,        // 评分数据
      phrases        // 乐句数据
    } = body;

    // 验证必填字段
    if (!voiceUrl) {
      return NextResponse.json(
        { error: '缺少必要参数' },
        { status: 400 }
      );
    }

    // 生成唯一分享ID
    const shareId = generateShareId();

    // 保存分享数据到数据库
    const { data, error } = await supabase
      .from('singing_shares')
      .insert({
        id: shareId,
        voice_url: voiceUrl,
        accompaniment_url: accompanimentUrl || null,
        score_image_url: scoreImageUrl || null,
        scores: scores || null,
        phrases: phrases || null,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error('Supabase insert error:', error);
      return NextResponse.json(
        { error: '保存分享数据失败' },
        { status: 500 }
      );
    }

    // 返回分享ID，前端自行拼接完整URL
    return NextResponse.json({
      success: true,
      shareId
    });

  } catch (error) {
    console.error('Share API error:', error);
    return NextResponse.json(
      { error: '服务器错误' },
      { status: 500 }
    );
  }
}
