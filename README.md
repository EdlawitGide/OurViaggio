# GatherRoute
Group trip planner: shareable trip link, itinerary, polls, expense splitting, AI activity ideas.
Stack: React + TypeScript (Vite), FastAPI, PostgreSQL, Docker.

    export GEMINI_API_KEY=your-key        # free key from aistudio.google.com, enables the AI ideas tab
    # optional alternative: export ANTHROPIC_API_KEY=...  (used only if no Gemini key is set)
    docker compose up --build             # app: http://localhost:8080  API docs: http://localhost:8000/docs

Auth model: no accounts. Creating or joining a trip issues a random token stored in the browser; anyone with the link can join by name.
