# Cache Eviction Strategy

**Summary**: An overview of the new cache eviction policy using Redis.
**Tags**: #redis #cache #devops

This document explains why we switched from a simple LRU cache to a more sophisticated Redis-based LFU (Least Frequently Used) approach. 
The main driver was the memory bloat observed in the staging environment.
