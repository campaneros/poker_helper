import argparse
import uvicorn

ap = argparse.ArgumentParser()
ap.add_argument("--lan", action="store_true", help="ascolta su tutta la rete (per il telefono)")
ap.add_argument("--port", type=int, default=8000)
a = ap.parse_args()
uvicorn.run("app.server:app", host="0.0.0.0" if a.lan else "127.0.0.1", port=a.port)
