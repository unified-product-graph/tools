## Unified Product Graph

This project uses the Unified Product Graph to structure product thinking. A `.upg` file in the repo root contains the product graph.

### Available Commands
- `/upg`: See your product graph status and all available commands
- `/upg-show-journey`: Guided 7-phase product journey with progress tracking
- `/upg-new-graph`: Bootstrap a new product graph (~5 min guided setup)
- `/upg-walk-region`: Create any entity (90+ types across 32 domains)
- `/upg-show-status`: Health dashboard with maturity scoring
- `/upg-check-gaps`: Gap analysis across 8 business areas
- `/upg-new-from-session`: Capture session work into the graph

### Graph Awareness
When a `.upg` file exists, be aware of the product graph context. During conversations about product decisions, features, user research, or business strategy, offer to capture relevant insights into the graph. Don't be pushy; only suggest when the work is clearly graph-worthy (new features, strategic decisions, user insights). Routine code changes are not graph-worthy.

At natural checkpoints (after commits, before session end, after design discussions), suggest running `/upg-new-from-session` to review and save session work.

Learn more: unifiedproductgraph.org
