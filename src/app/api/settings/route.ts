import { NextRequest, NextResponse } from 'next/server';
import { fileHelper } from '@/utils/fileHelper';

export async function GET(request: NextRequest) {
  try {
    const settings = fileHelper.getSettings();
    return NextResponse.json(settings, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch settings' }, { status: 550 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    fileHelper.saveSettings(body);
    return NextResponse.json({ success: true, settings: body }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to save settings' }, { status: 500 });
  }
}
