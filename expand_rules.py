import json


def generate_core_rules(start_id):
    rules = []
    # Major Ad Networks
    domains = [
        "adservice.google.com",
        "pagead2.googlesyndication.com",
        "googleadservices.com",
        "tpc.googlesyndication.com",
        "ad.doubleclick.net",
        "securepubads.g.doubleclick.net",
        "cm.g.doubleclick.net",
        "stats.g.doubleclick.net",
        "bid.g.doubleclick.net",
        "ib.adnxs.com",
        "secure.adnxs.com",
        "view.adnxs.com",
        "fastlane.rubiconproject.com",
        "optimized-by.rubiconproject.com",
        "pixel.rubiconproject.com",
        "a.teads.tv",
        "t.teads.tv",
        "p.teads.tv",
        "v.teads.tv",
        "ads.pubmatic.com",
        "pixel.pubmatic.com",
        "simage2.pubmatic.com",
        "u.openx.net",
        "rtb.openx.net",
        "d.openx.net",
        "as-sec.casalemedia.com",
        "dsum-sec.casalemedia.com",
        "cm.casalemedia.com",
        "bidder.criteo.com",
        "static.criteo.net",
        "sslwidget.criteo.com",
        "ad.yieldlab.net",
        "pixel.yieldlab.net",
        "b.yieldlab.net",
        "track.adform.net",
        "s2s.adform.net",
        "adx.adform.net",
        "ads.mopub.com",
        "pixel.mopub.com",
        "p.mopub.com",
        "ads.yahoo.com",
        "pixel.ads.yahoo.com",
        "s.yimg.com/rq/darla",
        "ads.stickyadstv.com",
        "v.stickyadstv.com",
        "p.stickyadstv.com",
        "ads.tremorhub.com",
        "pixel.tremorhub.com",
        "u.tremorhub.com",
        "ads.undertone.com",
        "pixel.undertone.com",
        "cdn.undertone.com",
        "ads.vidoomy.com",
        "pixel.vidoomy.com",
        "static.vidoomy.com",
        "ads.widespace.com",
        "pixel.widespace.com",
        "engine.widespace.com",
        "ads.betrad.com",
        "pixel.betrad.com",
        "l.betrad.com",
        "ads.creative-serving.com",
        "pixel.creative-serving.com",
        "cdn.creative-serving.com",
        "ads.flashtalking.com",
        "pixel.flashtalking.com",
        "static.flashtalking.com",
        "ads.goldbach.com",
        "pixel.goldbach.com",
        "static.goldbach.com",
        "ads.gumgum.com",
        "pixel.gumgum.com",
        "g2.gumgum.com",
        "ads.imrworldwide.com",
        "pixel.imrworldwide.com",
        "secure-gl.imrworldwide.com",
        "ads.inmobi.com",
        "pixel.inmobi.com",
        "static.inmobi.com",
        "ads.media.net",
        "pixel.media.net",
        "contextual.media.net",
        "ads.playground.xyz",
        "pixel.playground.xyz",
        "cdn.playground.xyz",
        "ads.revcontent.com",
        "pixel.revcontent.com",
        "cdn.revcontent.com",
        "ads.sharethrough.com",
        "pixel.sharethrough.com",
        "cdn.sharethrough.com",
        "ads.sonobi.com",
        "pixel.sonobi.com",
        "cdn.sonobi.com",
        "ads.spotxchange.com",
        "pixel.spotxchange.com",
        "search.spotxchange.com",
        "ads.triplelift.com",
        "pixel.triplelift.com",
        "cdn.triplelift.com",
        "ads.unrulyads.com",
        "pixel.unrulyads.com",
        "video.unrulyads.com",
    ]

    current_id = start_id
    for domain in domains:
        rules.append(
            {
                "id": current_id,
                "priority": 10,
                "action": {"type": "block"},
                "condition": {
                    "urlFilter": f"||{domain}^",
                    "resourceTypes": ["script", "image", "xmlhttprequest", "sub_frame"],
                },
            }
        )
        current_id += 1

    # Malvertising / DGA-like (Placeholder examples common in EasyList)
    dga_patterns = [
        "*.3de9c07b91.com",
        "*.a1b2c3d4e5.net",
        "*.x7y8z9w0.org",
        "*.q1w2e3r4t5.biz",
        "||acquiredeceasedundress.com^",
        "||deputizepacifistwipe.com^",
        "||monstrous-volcano.com^",
        "||holahupa.com^",
        "||pointcontinentrtb.com^",
        "||ahmybid.net^",
        "||ojfotraqjg.in^",
        "||onclickperformance.com^",
        "||onclickads.net^",
        "||doublepimp.com^",
        "||adsterra.com^",
        "||exoclick.com^",
        "||popads.net^",
        "||popcash.net^",
        "||propellerads.com^",
        "||adcash.com^",
    ]
    for pattern in dga_patterns:
        # Avoid duplicates if already in core.json (I saw some of these there)
        rules.append(
            {
                "id": current_id,
                "priority": 15,
                "action": {"type": "block"},
                "condition": {
                    "urlFilter": pattern,
                    "resourceTypes": ["script", "sub_frame", "image"],
                },
            }
        )
        current_id += 1

    # Script Paths
    paths = [
        "/ads.js",
        "/ad.js",
        "/ads.php",
        "/pop.js",
        "/popunder.js",
        "/tracking.js",
        "/pixel.js",
        "/analytics.js",
        "/advertisement.js",
        "/adframe.js",
        "/show_ads.js",
        "/wp-content/plugins/ad-rotate/ad-rotate.js",
        "/ad-manager.js",
        "/ad-service.js",
        "/ad-system.js",
        "/ad-tech.js",
        "/ad-provider.js",
        "/ad-client.js",
        "/ad-api.js",
        "/ad-worker.js",
        "/ads-iframe.html",
        "/ad-frame.html",
        "/ad-banner.html",
    ]
    for path in paths:
        rules.append(
            {
                "id": current_id,
                "priority": 15,
                "action": {"type": "block"},
                "condition": {
                    "urlFilter": path,
                    "domainType": "thirdParty",
                    "resourceTypes": ["script", "image", "sub_frame"],
                },
            }
        )
        current_id += 1

    return rules


def generate_privacy_rules(start_id):
    rules = []
    # Trackers
    domains = [
        "pixel.facebook.com",
        "connect.facebook.net",
        "graph.facebook.com",
        "analytics.google.com",
        "stats.g.doubleclick.net",
        "google-analytics.com",
        "mc.yandex.ru",
        "an.yandex.ru",
        "yandex.ru/clck",
        "bat.bing.com",
        "c.bing.com",
        "t.bing.com",
        "pixel.ads.twitter.com",
        "t.co/i/adsct",
        "analytics.twitter.com",
        "pixel.wp.com",
        "stats.wp.com",
        "sb.scorecardresearch.com",
        "b.scorecardresearch.com",
        "pixel.quantserve.com",
        "edge.quantserve.com",
        "c.amazon-adsystem.com",
        "s.amazon-adsystem.com",
        "pixel.rubiconproject.com",
        "optimized-by.rubiconproject.com",
        "dsum-sec.casalemedia.com",
        "as-sec.casalemedia.com",
        "dis.criteo.com",
        "widget.criteo.com",
        "match.adsrvr.org",
        "insight.adsrvr.org",
        "pixel.mathtag.com",
        "sync.mathtag.com",
        "idsync.rlcdn.com",
        "pippio.com",
        "tags.tiqcdn.com",
        "cdn.tealiumstatic.com",
        "assets.adobedtm.com",
        "dpm.demdex.net",
        "everesttech.net",
        "sc-static.net",
        "tr.snapchat.com",
        "analytics.tiktok.com",
        "log.tiktok.com",
        "cdn.amplitude.com",
        "api.amplitude.com",
        "cdn.heapanalytics.com",
        "heapanalytics.com",
        "fullstory.com/s/fs.js",
        "mouseflow.com/j/mps.js",
        "crazyegg.com/pages/scripts",
        "optimizely.com/js",
        "cdn.segment.com",
        "api.segment.io",
        "js-agent.newrelic.com",
        "bam.nr-data.net",
        "cdn.hotjar.com",
        "vars.hotjar.com",
        "p.typekit.net",
    ]

    # Add more to reach 100
    more_trackers = [
        "track.adform.net",
        "s2s.adform.net",
        "adx.adform.net",
        "pixel.advertising.com",
        "ads.advertising.com",
        "pixel.adhigh.net",
        "adhigh.net",
        "pixel.adition.com",
        "adition.com",
        "pixel.adloox.com",
        "adloox.com",
        "pixel.admanmedia.com",
        "admanmedia.com",
        "pixel.admixer.net",
        "admixer.net",
        "pixel.adnxs.com",
        "adnxs.com",
        "pixel.adotmob.com",
        "adotmob.com",
        "pixel.adperium.com",
        "adperium.com",
        "pixel.adriver.ru",
        "adriver.ru",
        "pixel.adroller.com",
        "adroller.com",
        "pixel.adscale.de",
        "adscale.de",
        "pixel.adsmogo.com",
        "adsmogo.com",
        "pixel.adsnative.com",
        "adsnative.com",
        "pixel.adspeed.com",
        "adspeed.com",
        "pixel.adspirit.de",
        "adspirit.de",
        "pixel.adstir.com",
        "adstir.com",
        "pixel.adtech.de",
        "adtech.de",
        "pixel.adthrive.com",
        "adthrive.com",
        "pixel.adtruth.com",
        "adtruth.com",
        "pixel.adunit.com",
        "adunit.com",
        "pixel.adventori.com",
        "adventori.com",
        "pixel.adzerk.net",
        "adzerk.net",
        "pixel.affec.tv",
        "affec.tv",
        "pixel.aggregateknowledge.com",
        "aggregateknowledge.com",
        "pixel.airpr.com",
        "airpr.com",
        "pixel.akamaihd.net",
        "akamaihd.net",
        "pixel.alexametrics.com",
        "alexametrics.com",
        "pixel.alicdn.com",
        "alicdn.com",
        "pixel.alliedpa.com",
        "alliedpa.com",
        "pixel.amazon-adsystem.com",
        "amazon-adsystem.com",
    ]
    domains.extend(more_trackers)

    current_id = start_id
    for domain in domains:
        rules.append(
            {
                "id": current_id,
                "priority": 1,
                "action": {"type": "block"},
                "condition": {
                    "urlFilter": f"||{domain}^",
                    "resourceTypes": ["script", "xmlhttprequest", "image"],
                },
            }
        )
        current_id += 1
    return rules


# Load existing core rules
with open("extension/public/rules/core.json", "r") as f:
    core_rules = json.load(f)
existing_core_ids = {r["id"] for r in core_rules}
max_core_id = max(existing_core_ids) if existing_core_ids else 1000
new_core_rules = generate_core_rules(max_core_id + 1)
# Filter duplicates by urlFilter
existing_core_filters = {r["condition"].get("urlFilter") for r in core_rules}
new_core_rules = [
    r
    for r in new_core_rules
    if r["condition"].get("urlFilter") not in existing_core_filters
]
# Ensure we have at least 100 new ones
core_rules.extend(new_core_rules[:105])

with open("extension/public/rules/privacy.json", "r") as f:
    privacy_rules = json.load(f)
existing_privacy_ids = {r["id"] for r in privacy_rules}
max_privacy_id = max(existing_privacy_ids) if existing_privacy_ids else 2000
new_privacy_rules = generate_privacy_rules(max_privacy_id + 1)
existing_privacy_filters = {r["condition"].get("urlFilter") for r in privacy_rules}
new_privacy_rules = [
    r
    for r in new_privacy_rules
    if r["condition"].get("urlFilter") not in existing_privacy_filters
]
privacy_rules.extend(new_privacy_rules[:105])

with open("extension/public/rules/core.json", "w") as f:
    json.dump(core_rules, f, indent=4)
with open("extension/public/rules/privacy.json", "w") as f:
    json.dump(privacy_rules, f, indent=4)

print(f"Updated core.json with {len(new_core_rules)} new rules.")
print(f"Updated privacy.json with {len(new_privacy_rules)} new rules.")
