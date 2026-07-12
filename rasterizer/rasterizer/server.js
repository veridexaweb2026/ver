import express from "express";
import multer from "multer";
import { pdf } from "pdf-to-img";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "veridexa-rasterizer" });
});

app.post("/rasterize", upload.single("file"), async (req, res) => {
  if (!req.file || req.file.mimetype !== "application/pdf") {
    return res.status(400).json({ error: "PDF_REQUIRED" });
  }

  try {
    const document = await pdf(req.file.buffer, { scale: 2 });
    const pages = [];

    let pageNumber = 0;

    for await (const image of document) {
      pageNumber += 1;

      if (pageNumber > 5) {
        break;
      }

      pages.push({
        page: pageNumber,
        mimeType: "image/png",
        base64: image.toString("base64")
      });
    }

    if (pages.length === 0) {
      return res.status(422).json({ error: "NO_PAGES_RENDERED" });
    }

    return res.status(200).json({
      ok: true,
      pageCount: pages.length,
      pages
    });
  } catch (error) {
    console.error("RASTERIZE_FAILED", error);

    return res.status(500).json({
      error: "RASTERIZE_FAILED"
    });
  }
});

const port = Number(process.env.PORT || 3000);

app.listen(port, "0.0.0.0", () => {
  console.log(`veridexa-rasterizer listening on ${port}`);
});
