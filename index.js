import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

const PORT = Number(process.env.PORT || 10000);

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(cors());

// -------------------- Utils
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomSleep = () => sleep(1000 + Math.random() * 500);

// -------------------- Health (Render precisa disso)
app.get("/", (_, res) => res.status(200).send("ok"));
app.get("/health", (_, res) => res.status(200).json({ ok: true }));

// -------------------- INPI Scraper
async function fetchInpiHtmlByMarca(marca) {
  console.log("[INPI] Launching browser");

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process",
    ],
  });

  try {
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36"
    );

    await page.setCacheEnabled(false);

    // 1) Home
    console.log("[INPI] Step 1 – Home");
    await page.goto("https://busca.inpi.gov.br/pePI/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await randomSleep();

    // 2) Login anônimo
    console.log("[INPI] Step 2 – Login");
    await page.goto(
      "https://busca.inpi.gov.br/pePI/servlet/LoginController?action=login",
      { waitUntil: "domcontentloaded", timeout: 60000 }
    );
    await randomSleep();

    // 3) Página de busca
    console.log("[INPI] Step 3 – Search page");
    await page.goto(
      "https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_basica.jsp",
      { waitUntil: "domcontentloaded", timeout: 60000 }
    );
    await randomSleep();

    // 4) Preencher formulário
    await page.waitForSelector('input[name="marca"]', { timeout: 30000 });
    await page.click('input[name="marca"]', { clickCount: 3 });
    await page.type('input[name="marca"]', marca, { delay: 40 });
    await randomSleep();

    // 5) Submeter
    console.log("[INPI] Submitting search");
    await Promise.all([
      page.waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: 60000,
      }),
      page.click('input[name="botao"]'),
    ]);

    await randomSleep();

    const html = await page.content();
    console.log("[INPI] HTML length:", html.length);

    return html;
  } finally {
    console.log("[INPI] Closing browser");
    await browser.close();
  }
}

// -------------------- API
app.post("/consulta-inpi", async (req, res) => {
  try {
    const marca = String(req.body?.marca || "").trim();
    console.log("[API] Consulta marca:", marca);

    if (!marca || marca.length < 2) {
      return res.status(400).json({
        ok: false,
        error: "Marca inválida",
      });
    }

    const html = await fetchInpiHtmlByMarca(marca);

    return res.status(200).json({
      ok: true,
      marca,
      html,
    });
  } catch (e) {
    console.error("[API ERROR]", e);
    return res.status(503).json({
      ok: false,
      error: "INPI indisponível ou erro de navegação",
    });
  }
});

// -------------------- Server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`INPI API running on port ${PORT}`);
});
