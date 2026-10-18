import { initDistributionCurves } from './website/ui/distribution';
import { initConfigurator } from './website/ui/configurator';
import { initIcons } from './website/ui/icons';
import { initTitleNotes } from './website/ui/title';
import { initCodeEditor } from './website/python/editor';
import { initVisualizer } from './website/visual/visualizer';

initIcons();
initVisualizer();
initDistributionCurves();
initConfigurator();
initTitleNotes();
initCodeEditor();