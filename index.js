import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

const PORT = Number(process.env.PORT || 10000);

const app = express();
app.use(express.json({ limit: "200kb" }));

/* =========================
   Utils
========================= */

function log(...args) {
  console.log("[API]", ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomSleep(min = 1000, max = 1500) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return sleep(ms);
}

/* =========================
   CORS (aberto)
========================= */

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

/* =========================
   Healthcheck
========================= */

app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

/* =========================
   Puppeteer Logic
========================= */

async function fetchInpiHtmlByMarca(marca) {
  log("Launching browser...");

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    const page = await browser.newPage();

    await page.setCacheEnabled(false);
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36"
    );

    page.on("requestfailed", (req) => {
      log("[requestfailed]", req.url(), req.failure()?.errorText);
    });

    const waitOpts = { waitUntil: "domcontentloaded", timeout: 45000 };

    /* ===== Etapa 1: Home ===== */
    log("Step 1 – Home");
    await page.goto("https://busca.inpi.gov.br/pePI/", waitOpts);
    await randomSleep();

    /* ===== Etapa 2: Login anônimo ===== */
    log("Step 2 – Login anônimo");
    await page.goto(
      "https://busca.inpi.gov.br/pePI/servlet/LoginController?action=login",
      waitOpts
    );
    await randomSleep();

    /* ===== Etapa 3: Página de busca ===== */
    log("Step 3 – Página de busca");
    await page.goto(
      "https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_basica.jsp",
      waitOpts
    );
    await randomSleep();

    /* ===== Etapa 4: Preencher formulário ===== */
    log("Step 4 – Preenchendo marca:", marca);
    await page.waitForSelector('input[name="marca"]', { timeout: 20000 });

    await page.click('input[name="marca"]', { clickCount: 3 });
    await page.type('input[name="marca"]', marca, { delay: 30 });

    await randomSleep();

    /* ===== Etapa 5: Submeter ===== */
    log("Step 5 – Submetendo busca");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45000 }),
      page.click('input[name="botao"]'),
    ]);

    await randomSleep();

    const html = await page.content();

    log("HTML recebido. Tamanho:", html.length);

    return html;
  } finally {
    log("Closing browser...");
    await browser.close();
  }
}

/* =========================
   API Endpoint
========================= */

app.post("/consulta-inpi", async (req, res) => {
  try {
    const marca = String(req.body?.marca || "").trim();
    log("Consulta marca:", marca);

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
    log("Erro:", e?.message || e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "Erro desconhecido",
    });
  }
});

/* =========================
   Server
========================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`INPI API running on port ${PORT}`);
});
