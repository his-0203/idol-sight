import { render } from "preact";
import { App } from "./App";
import { applyGlobalDefaults } from "./design/chart-defaults";
import "./styles.css";

// Apply Chart.js defaults once at boot — every chart in the app inherits
// the dark-surface tooltip + grid + font configuration after this call.
applyGlobalDefaults();

render(<App />, document.getElementById("app")!);
