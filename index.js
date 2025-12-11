const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // 1. Vai para o site principal
  await page.goto('https://busca.inpi.gov.br/pePI/');

  // 2. Faz login anônimo
  await page.goto('https://busca.inpi.gov.br/pePI/servlet/LoginController?action=login');

  // 3. Vai para a página da busca por marca
  await page.goto('https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_basica.jsp');

  // 4. Preenche o formulário e submete
  await page.type('input[name="marca"]', 'shinier');
  await page.click('input[name="botao"]'); // botão "Pesquisar"

  // Espera o resultado
  await page.waitForNavigation();

  // Pega HTML da página de resultados
  const html = await page.content();
  console.log(html);

  await browser.close();
})();
