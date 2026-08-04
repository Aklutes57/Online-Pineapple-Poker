import { buildServer } from './app.js';

const { httpServer } = buildServer();

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log(`Reg-Poker Online listening on http://localhost:${port}`);
});
