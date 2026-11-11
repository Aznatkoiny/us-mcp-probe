import { app } from "./app.js";
// Vercel imports the default export. Other hosts (and local runs) listen.
export default app;
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT || 8787);
  app.listen(port, () => console.log(`us-probe listening on :${port}`));
}
