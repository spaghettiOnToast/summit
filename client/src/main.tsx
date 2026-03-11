import { createRoot } from "react-dom/client";

import App from "./App";

// Dojo related imports
import { SoundProvider } from "@/contexts/sound";
import { QuestGuideProvider } from "@/contexts/QuestGuide";
import {
  DynamicConnectorProvider
} from "@/contexts/starknet.tsx";
import "./index.css";

async function main() {
  createRoot(document.getElementById("root")!).render(
    <DynamicConnectorProvider>
      <SoundProvider>
        <QuestGuideProvider>
          <App />
        </QuestGuideProvider>
      </SoundProvider>
    </DynamicConnectorProvider>
  );
}

main().catch((error) => {
  console.error("Failed to initialize the application:", error);
});
