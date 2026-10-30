import { defineConfig } from 'vitest/config'

// I test creano il proprio logger con un sink in memoria quando devono leggere le righe; per
// tutti gli altri il logger di processo resta muto, così l'output della suite è leggibile.
export default defineConfig({
  test: { env: { LOG_LEVEL: 'silent' } },
})
