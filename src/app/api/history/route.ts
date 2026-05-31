import { NextRequest, NextResponse } from 'next/server';
import { fileHelper } from '@/utils/fileHelper';

export async function GET(request: NextRequest) {
  fileHelper.ensureDirectories();
  const history = fileHelper.getHistory();
  return NextResponse.json(history, { status: 200 });
}
