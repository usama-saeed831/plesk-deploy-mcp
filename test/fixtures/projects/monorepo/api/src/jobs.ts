import { Cron } from '@nestjs/schedule';
export class Jobs { @Cron('0 * * * *') hourly() {} }
