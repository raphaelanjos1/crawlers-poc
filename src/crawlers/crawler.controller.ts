import { Controller, Get } from '@nestjs/common';
import { CrawlerService } from './crawler.service';

@Controller('crawl')
export class CrawlerController {
  constructor(private readonly crawlerService: CrawlerService) {}

  // Get /crawl para iniciar
  @Get()
  async crawl() {
    const products = await this.crawlerService.crawl();
    return {
      message: 'Crawling concluído',
      count: products.length,
      products,
    };
  }
}