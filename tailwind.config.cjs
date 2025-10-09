module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx,jsx,js}'],
  theme: {
    extend: {
      colors: {
        primary: '#6A4C93',
        accent: '#1E3A8A',
        ink: '#0F172A',
        surface: '#FAF9FB'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'Arial', 'sans-serif']
      }
    }
  },
  plugins: []
};
