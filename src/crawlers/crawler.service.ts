import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { chromium, BrowserContext } from 'playwright';
import pLimit from 'p-limit';

export interface Product {
  id: string;        
  code: string;
  name: string;
  description: string;
  categoryTree: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkuSpecification {
  name: string;
  values: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Sku {
  id: string;
  link: string;
  productId: string;
  name: string;         
  code: string;         
  images: string[];     
  createdAt: string;
  updatedAt: string;
  skuSpecifications: SkuSpecification[];
}

@Injectable()
export class CrawlerService {
  private readonly logger = new Logger(CrawlerService.name);
  private readonly baseUrl = 'https://havaianas.com.br/collections/todos';
  // Número total de páginas (trocar por loop ate nao encontrar)
  private readonly totalPages = 60;
  private readonly delayMs = 2000;
  private readonly waitTimeout = 30000;

  /**
   * Método principal de crawling:
   * - Percorre as páginas de listagem;
   * - Dentro de cada página, busca apenas os produtos contidos na <ul class="product-grid">;
   * - Processa as páginas de detalhe de cada produto de forma concorrente (limitado a 5 simultâneas pelo pLimit);
   * - Salva os produtos e os SKUs em arquivos JSON.
   */
  async crawl(): Promise<{ products: Product[], skus: Sku[] }> {
    const startTime = Date.now();
    let products: Product[] = [];
    let skus: Sku[] = [];
    const browser = await chromium.launch({ headless: true });

    // Loop pelas páginas de listagem
    for (let pageNumber = 1; pageNumber <= this.totalPages; pageNumber++) {
      this.logger.log(`Buscando página ${pageNumber}`);
      const url = `${this.baseUrl}?page=${pageNumber}`;

      try {
        const context: BrowserContext = await browser.newContext({
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/112.0.0.0 Safari/537.36',
          viewport: { width: 1280, height: 720 },
          extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
        });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.waitTimeout });
        // Aguarda que a lista de produtos esteja presente
        await page.waitForSelector('ul.product-grid', { timeout: this.waitTimeout });
        const html = await page.content();
        const $ = cheerio.load(html);
        const productDetailUrls: string[] = [];
        
        // Seleciona apenas os anchors dentro da <ul class="product-grid">
        $('ul.product-grid li div[data-product-image] a').each((i, el) => {
          let href = $(el).attr('href');
          if (href) {
            if (!href.startsWith('http')) {
              href = `https://havaianas.com.br${href}`;
            }
            productDetailUrls.push(href);
          }
        });
        this.logger.log(`Página ${pageNumber} encontrou ${productDetailUrls.length} produtos na grid.`);
        
        // Processamento concorrente (limitado a 5/6/12? requisições simultâneas)
        const limit = pLimit(5);
        const detailPromises = productDetailUrls.map((detailUrl) =>
          limit(() =>
            this.fetchProductDetail(detailUrl, browser).catch((err) => {
              this.logger.error(`Erro ao processar ${detailUrl}: ${err.message}`);
              return null;
            })
          )
        );
        const results = await Promise.all(detailPromises);
        results.forEach((result) => {
          if (result) {
            products.push(result.product);
            skus.push(...result.skus);
          }
        });
        await page.close();
        await context.close();
      } catch (error: any) {
        this.logger.error(`Erro ao buscar a página ${pageNumber}: ${error.message}`);
      }
      if (pageNumber < this.totalPages) {
        await this.delay(this.delayMs);
      }
    }
    await browser.close();
    this.saveProducts(products);
    this.saveSkus(skus);
    const endTime = Date.now();
    const durationSeconds = (endTime - startTime) / 1000;
    this.logger.log(`Tempo total de execução: ${durationSeconds.toFixed(2)} segundos`);
    this.logger.log(`Total de produtos salvos: ${products.length}`);
    this.logger.log(`Total de skus salvos: ${skus.length}`);

    return { products, skus };
  }

  /**
   * Processa a página de detalhe de um produto.
   * Extrai o JSON do produto (via script com "var product = ..."),
   * as imagens e as especificações, e constrói os objetos Product e Sku.
   */
  private async fetchProductDetail(url: string, browser: any): Promise<{ product: Product, skus: Sku[] }> {
    this.logger.log(`Processando produto: ${url}`);
    const context: BrowserContext = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/112.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.waitTimeout });
    const html = await page.content();
    const $ = cheerio.load(html);

    // Extrai a tag <script> que contém "var product ="
    const scriptTag = $('script')
      .filter((i, el) => {
        const scriptHtml = $(el).html();
        return scriptHtml ? scriptHtml.includes('var product =') : false;
      })
      .first()
      .html();

    if (!scriptTag) {
      throw new Error('Script com var product não encontrado');
    }

    // Extrai o JSON do produto usando regex
    const regex = /var\s+product\s*=\s*(\{.*\});/s;
    const match = scriptTag.match(regex);
    if (!match || match.length < 2) {
      throw new Error('Não foi possível extrair o JSON do produto');
    }
    let productData;
    try {
      productData = JSON.parse(match[1]);
    } catch (err: any) {
      throw new Error('Erro ao parsear JSON do produto: ' + err.message);
    }

    // Constrói o objeto Product
    const product: Product = {
      id: uuidv4(),
      code: productData.id.toString(),
      name: productData.title,
      description: this.stripHtml(productData.description),
      categoryTree: productData.type,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Extrai imagens dos elementos com a classe "product__media"
    const images: string[] = [];
    $('div.product__media img').each((i, el) => {
      let src = $(el).attr('src');
      if (src) {
        if (src.startsWith('//')) {
          src = 'https:' + src;
        }
        images.push(src);
      }
    });

    // Extrai especificações extras dos accordions
    const extraSpecifications: SkuSpecification[] = [];
    $('div.accordion-item-container').each((i, container) => {
      const specName = $(container).find('.accordion-item').text().trim();
      const specValue = $(container).find('.product__description').text().trim();
      if (specName.toLowerCase() === 'descrição') {
        return; // ignora "Descrição"
      }
      if (specName && specValue) {
        extraSpecifications.push({
          name: specName,
          values: [specValue],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    });

    // Cria os objetos Sku a partir das variantes
    const skus: Sku[] = [];
    if (productData.variants && Array.isArray(productData.variants)) {
      const baseDetailUrl = url.split('?')[0];
      for (const variant of productData.variants) {
        const skuName = `${productData.title} - ${variant.option1} / ${variant.option2}`;
        const basicSpecs: SkuSpecification[] = [
          {
            name: 'Cor',
            values: [variant.option1],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          {
            name: 'Tamanho',
            values: [variant.option2],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
        ];
        const skuSpecifications = basicSpecs.concat(extraSpecifications);
        // Gera o link do sku: baseDetailUrl + "?variant=" + variant.id
        const skuLink = `${baseDetailUrl}?variant=${variant.id}`;
        const sku: Sku = {
          id: uuidv4(),
          link: skuLink,
          productId: product.id,
          name: skuName,
          code: variant.sku,
          images: images,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          skuSpecifications: skuSpecifications
        };
        skus.push(sku);
      }
    }

    await page.close();
    await context.close();
    return { product, skus };
  }

  // Remove as tags HTML de uma string, retornando somente o texto.
  private stripHtml(html: string): string {
    const $ = cheerio.load(html);
    return $.root().text().trim();
  }

  // Salvando products
  private saveProducts(products: Product[]) {
    const storageDir = path.join(process.cwd(), 'src', 'storage', 'products');
    const filePath = path.join(storageDir, 'products.json');
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(products, null, 2), 'utf8');
    this.logger.log(`Salvou ${products.length} produtos em ${filePath}`);
  }
  
  // Salvando skus
  private saveSkus(skus: Sku[]) {
    const storageDir = path.join(process.cwd(), 'src', 'storage', 'skus');
    const filePath = path.join(storageDir, 'skus.json');
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(skus, null, 2), 'utf8');
    this.logger.log(`Salvou ${skus.length} skus em ${filePath}`);
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
