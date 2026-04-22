import express from "express";
import cors from "cors";
import { attachWebSocketServer } from "./server.js";

const apiKey = process.env.TAMER_API_KEY;
if (!apiKey || apiKey.trim() === "") {
  console.error("FATAL: TAMER_API_KEY environment variable is required");
  process.exit(1);
}

const app = express();
const port = parseInt(process.env.PORT || "3000", 10);

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const httpServer = app.listen(port, "0.0.0.0", () => {
  console.log(`tamer-ai server listening on port ${port}`);
});

const relay = attachWebSocketServer(httpServer, { apiKey });

process.on("SIGTERM", () => { relay.close(); httpServer.close(); });
process.on("SIGINT", () => { relay.close(); httpServer.close(); });
