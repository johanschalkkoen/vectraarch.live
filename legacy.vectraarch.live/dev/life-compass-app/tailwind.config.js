/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        background: '#0B0B0E', // Deep pitch black
        cardBg: '#13131A',     // Slightly lighter black for cards
        neonPink: '#FF2A85',   // Female Koen color
        neonTeal: '#00F2FE',   // Girl Koen color
        neonGreen: '#00FF87',  // Boy Koen color
        neonBlue: '#2A85FF',   // Male Koen color
        mutedGray: '#4A4A5A',  // Borders and text
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'], // For that sharp data look
      }
    },
  },
  plugins: [],
}
