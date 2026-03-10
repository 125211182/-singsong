/**
 * 分享API - 获取分享数据
 * GET /api/share/[id]
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // 延迟初始化Supabase客户端
  const supabase = getSupabaseClient();
  
  try {
    const { id: shareId } = await params;

    if (!shareId) {
      return NextResponse.json(
        { error: '缺少分享ID' },
        { status: 400 }
      );
    }

    // 从数据库获取分享数据
    const { data, error } = await supabase
      .from('singing_shares')
      .select('*')
      .eq('id', shareId)
      .single();

    if (error) {
      console.error('Supabase query error:', error);
      return NextResponse.json(
        { error: '分享数据不存在或已过期' },
        { status: 404 }
      );
    }

    if (!data) {
      return NextResponse.json(
        { error: '分享数据不存在' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        voiceUrl: data.voice_url,
        accompanimentUrl: data.accompaniment_url,
        scoreImageUrl: data.score_image_url,
        scores: data.scores,
        phrases: data.phrases,
        createdAt: data.created_at
      }
    });

  } catch (error) {
    console.error('Get share API error:', error);
    return NextResponse.json(
      { error: '服务器错误' },
      { status: 500 }
    );
  }
}
