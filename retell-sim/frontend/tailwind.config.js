/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  "#fff7ed",
          100: "#ffedd5",
          200: "#fed7aa",
          300: "#fdba74",
          400: "#fb923c",
          500: "#F5820D",
          600: "#D96D08",
          700: "#B85706",
          800: "#92450c",
          900: "#763a0e",
        },
        ink: {
          900: "#0F1115",
          700: "#2A2D34",
          500: "#5B616E",
          400: "#858B97",
          300: "#AAB0BB",
        },
        line: {
          DEFAULT: "#ECECEA",
          soft: "#F1F1EF",
          strong: "#DEDEDB",
        },
        canvas: {
          DEFAULT: "#FAFAF8",
          raised: "#FFFFFF",
          sunken: "#F4F4F2",
        },
      },
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "sans-serif"],
        mono: ["SF Mono", "JetBrains Mono", "Fira Code", "monospace"],
      },
      boxShadow: {
        card:   "0 1px 2px rgba(16,17,21,0.04), 0 1px 3px rgba(16,17,21,0.06)",
        raised: "0 4px 12px rgba(16,17,21,0.06), 0 2px 4px rgba(16,17,21,0.04)",
        pop:    "0 12px 32px rgba(16,17,21,0.12), 0 4px 8px rgba(16,17,21,0.06)",
        brand:  "0 4px 14px rgba(245,130,13,0.30)",
      },
      borderRadius: {
        xl: "12px",
        "2xl": "16px",
        "3xl": "20px",
      },
      keyframes: {
        "fade-in": { from: { opacity: 0 }, to: { opacity: 1 } },
        "slide-up": {
          from: { opacity: 0, transform: "translateY(6px)" },
          to: { opacity: 1, transform: "translateY(0)" },
        },
        "scale-in": {
          from: { opacity: 0, transform: "scale(0.97)" },
          to: { opacity: 1, transform: "scale(1)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.2s ease-out",
        "slide-up": "slide-up 0.25s cubic-bezier(0.16,1,0.3,1)",
        "scale-in": "scale-in 0.18s cubic-bezier(0.16,1,0.3,1)",
      },
    },
  },
  plugins: [],
};
