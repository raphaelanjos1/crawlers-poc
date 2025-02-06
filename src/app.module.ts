import { Module } from '@nestjs/common';
import { CrawlersModule } from './crawlers/crawler.module';

@Module({
  imports: [CrawlersModule],
  controllers: [],
  providers: [],
})
export class AppModule {}