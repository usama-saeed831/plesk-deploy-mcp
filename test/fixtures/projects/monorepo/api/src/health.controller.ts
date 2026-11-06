import { Controller, Get } from '@nestjs/common';
@Controller('health')
export class HealthController {
  constructor(private readonly config: { get(name: string): string }) {}
  @Get('ready')
  ready() {
    const secret = this.config.get('JWT_SECRET');
    return { status: 'ready', release: process.env.RELEASE_VERSION, db: !!process.env.DATABASE_URL, s: !!secret };
  }
}
