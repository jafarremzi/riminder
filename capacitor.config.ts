import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ir.yadavareh.souti',
  appName: 'یادآور صوتی',
  webDir: 'dist',
  bundledWebRuntime: false,
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_icon_config_sample',
      iconColor: '#8b7cff'
    },
    SpeechRecognition: {
      popup: false
    }
  }
};
export default config;