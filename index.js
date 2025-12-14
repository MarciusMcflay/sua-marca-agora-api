import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json());

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;

app.post("/consulta-inpi", async (req, res) => {
  if (req.headers["x-internal-token"] !== INTERNAL_API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { marca } = req.body;
  if (!marca) {
    return res.status(400).json({ error: "Marca obrigatória" });
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  await page.goto("https://busca.inpi.gov.br/pePI/");
  await page.goto("https://busca.inpi.gov.br/pePI/servlet/LoginController?action=login");
  await page.goto("https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_basica.jsp");

  await page.type('input[name="marca"]', marca);
  await page.click('input[name="botao"]');

  await page.waitForNavigation({ waitUntil: "networkidle2" });

  const html = await page.content();

  await browser.close();

  res.json({ ok: true, html });
});

app.listen(3000, () => {
  console.log("INPI Puppeteer API running");
});
