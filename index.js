import express from "express";
import cors from "cors";
import puppeteer from "puppeteer-core";

const app = express();
app.use(express.json({ limit: "200kb" }));

// CORS defensivo (opcional)
app.use(cors({ origin: false }));

// Segurança real: só Supabase chama
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
if (!INTERNAL_API_TOKEN) throw new Error("Missing INTERNAL_API_TOKEN");

app.use((req, res, next) => {
  if (req.header("X-Internal-Token") !== INTERNAL_API_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
});

async function inpiSearchHtml(marca) {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote"
    ]
  });

  try {
    const page = await browser.newPage();

    // Sequência que você confirmou que funciona
    await page.goto("https://busca.inpi.gov.br/pePI/", { waitUntil: "domcontentloaded" });
    await page.goto("https://busca.inpi.gov.br/pePI/servlet/LoginController?action=login", { waitUntil: "domcontentloaded" });
    await page.goto("https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_basica.jsp", { waitUntil: "domcontentloaded" });

    await page.waitForSelector('input[name="marca"]', { timeout: 15000 });
    await page.focus('input[name="marca"]');
    await page.keyboard.type(marca);

    // Clicar no botão de submit do formulário
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }),
      page.click('input[name="botao"]')
    ]);

    const html = await page.content();
    return html;
  } finally {
    await browser.close();
  }
}

app.post("/consulta-inpi", async (req, res) => {
  try {
    const marca = String(req.body?.marca || "").trim();
    if (!marca) return res.status(400).json({ ok: false, error: "marca is required" });

    const html = await inpiSearchHtml(marca);
    return res.json({ ok: true, marca, html });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("INPI API up"));
