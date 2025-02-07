import { Controller, Get } from '@nestjs/common';
import { CrawlerService } from './crawler.service';

@Controller('crawl')
export class CrawlerController {
  constructor(private readonly crawlerService: CrawlerService) {}

  @Get()
  async crawl() {
    const { products, skus } = await this.crawlerService.crawl();
    return {
      message: 'Crawling concluído',
      productCount: products.length,
      skuCount: skus.length,
      products,
      skus,
    };
  }
}