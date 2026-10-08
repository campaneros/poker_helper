import time
from poker.model import train

t = time.time()
print(train(), f"{time.time() - t:.0f}s")
