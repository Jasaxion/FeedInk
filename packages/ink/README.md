# FeedInk annotation engine

Portable annotation components adapted from [WebInk](https://github.com/Jasaxion/WebInk), used with the project owner’s authorization under Apache-2.0. See `LICENSE` and the repository `NOTICE`. Only the portable source subset is included; no private configuration, user data, native application, operational documentation or upstream history is redistributed.

The automatic global injection entry is deliberately excluded. FeedInk supplies its own reader-scoped lifecycle, persistence and browser-input adapter. Browser mode must be explicit; a storage callback must not implicitly enable native-host input. Durable save status belongs to the adapter/server, not the engine’s synchronous transport receipt.

FeedInk-specific changes must be identified in modified source headers. Raw stroke/anchor data remains the restoration format; export projections are presentation data only.
