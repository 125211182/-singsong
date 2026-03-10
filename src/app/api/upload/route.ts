/**
 * 上传API - 上传文件到对象存储
 * POST /api/upload
 */

import { NextRequest, NextResponse } from 'next/server';
import { S3Storage } from 'coze-coding-dev-sdk';

// 增加body大小限制 - Next.js App Router 方式
export const runtime = 'nodejs';
export const maxDuration = 300; // 5分钟超时

// 初始化对象存储
const storage = new S3Storage({
  endpointUrl: process.env.COZE_BUCKET_ENDPOINT_URL,
  accessKey: '',
  secretKey: '',
  bucketName: process.env.COZE_BUCKET_NAME,
  region: 'cn-beijing',
});

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const type = formData.get('type') as string; // voice, accompaniment, score

    if (!file) {
      return NextResponse.json(
        { error: '缺少文件' },
        { status: 400 }
      );
    }

    // 转换文件为Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 生成文件名
    const timestamp = Date.now();
    const ext = file.name.split('.').pop() || 'bin';
    const fileName = `${type || 'files'}/${timestamp}_${file.name}`;

    // 确定Content-Type
    const contentTypes: Record<string, string> = {
      wav: 'audio/wav',
      mp3: 'audio/mpeg',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
    };
    const contentType = contentTypes[ext.toLowerCase()] || 'application/octet-stream';

    // 上传文件
    const key = await storage.uploadFile({
      fileContent: buffer,
      fileName,
      contentType,
    });

    // 生成签名URL（有效期30天）
    const url = await storage.generatePresignedUrl({
      key,
      expireTime: 2592000, // 30天
    });

    return NextResponse.json({
      success: true,
      key,
      url,
    });

  } catch (error) {
    console.error('Upload API error:', error);
    const errorMessage = error instanceof Error ? error.message : '上传失败';
    return NextResponse.json(
      { error: errorMessage, success: false },
      { status: 500 }
    );
  }
}
