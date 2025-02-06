import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { chromium, BrowserContext } from 'playwright';

export interface Product {
  id: string;
  code: string;
  categoryTree: string;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class CrawlerService {
  private readonly logger = new Logger(CrawlerService.name);
  private readonly baseUrl = 'https://havaianas.com.br/collections/todos';
  // Para teste, usaremos 5 páginas; ajustar para testar com maximo.
  private readonly totalPages = 5;
  private readonly delayMs = 2000;
  // Timeout para nao cair em rate limit
  private readonly waitTimeout = 30000;

  // Executa o crawler com o playwright
  async crawl(): Promise<Product[]> {
    let products: Product[] = [];
    // Lança o browser somente uma vez e com modo headless
    const browser = await chromium.launch({ headless: true });

    for (let pageNumber = 1; pageNumber <= this.totalPages; pageNumber++) {
      this.logger.log(`Buscando página ${pageNumber}`);
      const url = `${this.baseUrl}?page=${pageNumber}`;

      try {
        // Simulando um navegador real
        const context: BrowserContext = await browser.newContext({
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/112.0.0.0 Safari/537.36',
          viewport: { width: 1280, height: 720 },
          extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });
        const page = await context.newPage();

        // Navega para a URL e aguarda o evento 'load'
        await page.goto(url, { waitUntil: 'load', timeout: this.waitTimeout });

        // Verificar bloqueio do Cloudflare
        const title = await page.title();
        if (title.includes('Attention Required') || title.includes('blocked')) {
          this.logger.error(`Página ${pageNumber} bloqueada pelo Cloudflare. Título: ${title}`);
          // Fecha a página e o contexto e pula para a próxima página
          await page.close();
          await context.close();
          continue;
        }

        // Aguarda que os elementos dos produtos sejam carregados
        await page.waitForSelector('li.grid__item', { timeout: this.waitTimeout });

        // Obtém o conteúdo HTML completo da página
        const html = await page.content();
        this.logger.log(`Tamanho do HTML da página ${pageNumber}: ${html.length}`);

        await page.close();
        await context.close();

        // Faz o parsing do HTML para extrair os produtos
        const pageProducts = this.parseProducts(html);
        this.logger.log(`Página ${pageNumber} retornou ${pageProducts.length} produtos.`);
        products = products.concat(pageProducts);
      } catch (error: any) {
        this.logger.error(`Erro ao buscar a página ${pageNumber}: ${error.message}`);
      }

      if (pageNumber < this.totalPages) {
        await this.delay(this.delayMs);
      }
    }

    await browser.close();
    this.logger.log(`Total de produtos extraídos: ${products.length}`);
    this.saveProducts(products);
    return products;
  }

  // Delay
  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

// Realiza o parsing do HTML pela <li> que contém a div com classe "product-card".
  private parseProducts(html: string): Product[] {
    const $ = cheerio.load(html);
    const productElements = $('li.grid__item');
    const products: Product[] = [];

    productElements.each((index, element) => {
      const productCard = $(element).find('div.product-card');
      if (!productCard.length) return;

      const categoryTree = productCard.attr('data-product-type') || '';
      const productInfo = $(element).find('div.product-info');
      const skuElement = productInfo.find('[data-sku]');
      const code = skuElement.attr('data-sku') || '';

      if (code) {
        const now = new Date().toISOString();
        const product: Product = {
          id: uuidv4(),
          code,
          categoryTree,
          createdAt: now,
          updatedAt: now,
        };
        products.push(product);
      }
    });

    return products;
  }

  // Salva o array de produtos em storage/Products/products.json.
  private saveProducts(products: Product[]) {
    const storageDir = path.join(process.cwd(), 'src', 'storage', 'Products');
    const filePath = path.join(storageDir, 'products.json');

    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }

    const fileContent = JSON.stringify(products, null, 2);
    fs.writeFileSync(filePath, fileContent, 'utf8');
    this.logger.log(`Salvou ${products.length} produtos em ${filePath}`);

    // Log opcional para verificação
    const savedContent = fs.readFileSync(filePath, 'utf8');
    this.logger.log(`Conteúdo salvo (primeiros 200 caracteres): ${savedContent.slice(0, 200)}`);
  }

}
