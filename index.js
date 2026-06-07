import { AppRegistry, Image, DeviceEventEmitter } from 'react-native';
import App from './src/App';
import { name as appName } from './app.json';
import { PluginManager } from 'sn-plugin-lib';

AppRegistry.registerComponent(appName, () => App);
PluginManager.init();

const BUTTON_ID = 1;

// Toolbar button (type 1) with showType:1 → pressing it opens the full-screen
// App view, which presents the export-scope chooser and runs the export.
PluginManager.registerButton(1, ['NOTE', 'DOC'], {
  id: BUTTON_ID,
  name: 'Export Color PDF',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: 1,
});

// The PluginHost re-shows the SAME React component on every button press without
// remounting it, and closePluginView() only hides the view — so App keeps its
// previous state (e.g. the "Done" screen). Emit a reset on each press so App can
// re-arm the chooser whenever the view reopens.
PluginManager.registerButtonListener({
  onButtonPress: (msg) => {
    if (!msg || msg.id !== BUTTON_ID) return;
    DeviceEventEmitter.emit('colorPdfExportReset');
  },
});
