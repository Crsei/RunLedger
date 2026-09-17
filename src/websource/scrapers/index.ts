/**
 * Web Fetch Special Handlers Index
 *
 * Exports all special handlers for site-specific content extraction.
 */
import { handleArtifactHub } from "./artifacthub.ts";
import { handleArxiv } from "./arxiv.ts";
import { handleAur } from "./aur.ts";
import { handleBiorxiv } from "./biorxiv.ts";
import { handleBluesky } from "./bluesky.ts";
import { handleBrew } from "./brew.ts";
import { handleCheatSh } from "./cheatsh.ts";
import { handleChocolatey } from "./chocolatey.ts";
import { handleChooseALicense } from "./choosealicense.ts";
import { handleCisaKev } from "./cisa-kev.ts";
import { handleClojars } from "./clojars.ts";
import { handleCoinGecko } from "./coingecko.ts";
import { handleCratesIo } from "./crates-io.ts";
import { handleCrossref } from "./crossref.ts";
import { handleDevTo } from "./devto.ts";
import { handleDiscogs } from "./discogs.ts";
import { handleDiscourse } from "./discourse.ts";
import { handleDockerHub } from "./dockerhub.ts";
import { handleDocsRs } from "./docs-rs.ts";
import { handleFdroid } from "./fdroid.ts";
import { handleFirefoxAddons } from "./firefox-addons.ts";
import { handleFlathub } from "./flathub.ts";
import { fetchGitHubApi, handleGitHub } from "./github.ts";
import { handleGitHubGist } from "./github-gist.ts";
import { handleGitLab } from "./gitlab.ts";
import { handleGoPkg } from "./go-pkg.ts";
import { handleHackage } from "./hackage.ts";
import { handleHackerNews } from "./hackernews.ts";
import { handleHex } from "./hex.ts";
import { handleHuggingFace } from "./huggingface.ts";
import { handleIacr } from "./iacr.ts";
import { handleJetBrainsMarketplace } from "./jetbrains-marketplace.ts";
import { handleLemmy } from "./lemmy.ts";
import { handleLobsters } from "./lobsters.ts";
import { handleMastodon } from "./mastodon.ts";
import { handleMaven } from "./maven.ts";
import { handleMDN } from "./mdn.ts";
import { handleMetaCPAN } from "./metacpan.ts";
import { handleMusicBrainz } from "./musicbrainz.ts";
import { handleNpm } from "./npm.ts";
import { handleNuGet } from "./nuget.ts";
import { handleNvd } from "./nvd.ts";
import { handleOllama } from "./ollama.ts";
import { handleOpenVsx } from "./open-vsx.ts";
import { handleOpenCorporates } from "./opencorporates.ts";
import { handleOpenLibrary } from "./openlibrary.ts";
import { handleOrcid } from "./orcid.ts";
import { handleOsv } from "./osv.ts";
import { handlePackagist } from "./packagist.ts";
import { handlePubDev } from "./pub-dev.ts";
import { handlePubMed } from "./pubmed.ts";
import { handlePyPI } from "./pypi.ts";
import { handleRawg } from "./rawg.ts";
import { handleReadTheDocs } from "./readthedocs.ts";
import { handleReddit } from "./reddit.ts";
import { handleRepology } from "./repology.ts";
import { handleRfc } from "./rfc.ts";
import { handleRubyGems } from "./rubygems.ts";
import { handleSearchcode } from "./searchcode.ts";
import { handleSecEdgar } from "./sec-edgar.ts";
import { handleSemanticScholar } from "./semantic-scholar.ts";
import { handleSnapcraft } from "./snapcraft.ts";
import { handleSourcegraph } from "./sourcegraph.ts";
import { handleSpdx } from "./spdx.ts";
import { handleSpotify } from "./spotify.ts";
import { handleStackOverflow } from "./stackoverflow.ts";
import { handleTerraform } from "./terraform.ts";
import { handleTldr } from "./tldr.ts";
import { handleTwitter } from "./twitter.ts";
import type { ScraperContext, SpecialHandler } from "./types.ts";
import { handleVimeo } from "./vimeo.ts";
import { handleVscodeMarketplace } from "./vscode-marketplace.ts";
import { handleW3c } from "./w3c.ts";
import { handleWikidata } from "./wikidata.ts";
import { handleWikipedia } from "./wikipedia.ts";

export type { RenderResult, SpecialHandler } from "./types.ts";

export {
	fetchGitHubApi,
	handleArtifactHub,
	handleArxiv,
	handleAur,
	handleBiorxiv,
	handleBluesky,
	handleBrew,
	handleCheatSh,
	handleChocolatey,
	handleChooseALicense,
	handleCisaKev,
	handleClojars,
	handleCoinGecko,
	handleCratesIo,
	handleCrossref,
	handleDevTo,
	handleDiscogs,
	handleDiscourse,
	handleDockerHub,
	handleDocsRs,
	handleFdroid,
	handleFirefoxAddons,
	handleFlathub,
	handleGitHub,
	handleGitHubGist,
	handleGitLab,
	handleGoPkg,
	handleHackage,
	handleHackerNews,
	handleHex,
	handleHuggingFace,
	handleIacr,
	handleJetBrainsMarketplace,
	handleLemmy,
	handleLobsters,
	handleMastodon,
	handleMaven,
	handleMDN,
	handleMetaCPAN,
	handleMusicBrainz,
	handleNpm,
	handleNuGet,
	handleNvd,
	handleOllama,
	handleOpenCorporates,
	handleOpenLibrary,
	handleOpenVsx,
	handleOrcid,
	handleOsv,
	handlePackagist,
	handlePubDev,
	handlePubMed,
	handlePyPI,
	handleRawg,
	handleReadTheDocs,
	handleReddit,
	handleRepology,
	handleRfc,
	handleRubyGems,
	handleSearchcode,
	handleSecEdgar,
	handleSemanticScholar,
	handleSnapcraft,
	handleSourcegraph,
	handleSpdx,
	handleSpotify,
	handleStackOverflow,
	handleTerraform,
	handleTldr,
	handleTwitter,
	handleVimeo,
	handleVscodeMarketplace,
	handleW3c,
	handleWikidata,
	handleWikipedia,
};

export const specialHandlers: SpecialHandler[] = [
	// Git hosting
	handleGitHubGist,
	handleGitHub,
	handleGitLab,
	// Video/Media
	handleVimeo,
	handleSpotify,
	handleDiscogs,
	handleMusicBrainz,
	// Games
	handleRawg,
	// Social/News
	handleTwitter,
	handleBluesky,
	handleMastodon,
	handleLemmy,
	handleHackerNews,
	handleLobsters,
	handleReddit,
	handleDiscourse,
	// Developer content
	handleStackOverflow,
	handleDevTo,
	handleMDN,
	handleDocsRs,
	handleReadTheDocs,
	handleSearchcode,
	handleSourcegraph,
	handleTldr,
	handleCheatSh,
	// Package registries
	handleNpm,
	handleFirefoxAddons,
	handleVscodeMarketplace,
	handleNuGet,
	handleChocolatey,
	handleClojars,
	handleBrew,
	handlePyPI,
	handleCratesIo,
	handleDockerHub,
	handleFdroid,
	handleFlathub,
	handleGoPkg,
	handleHex,
	handlePackagist,
	handlePubDev,
	handleMaven,
	handleJetBrainsMarketplace,
	handleOpenVsx,
	handleArtifactHub,
	handleRubyGems,
	handleTerraform,
	handleAur,
	handleHackage,
	handleMetaCPAN,
	handleRepology,
	handleSnapcraft,
	// ML/AI
	handleHuggingFace,
	handleOllama,
	// Academic
	handleArxiv,
	handleBiorxiv,
	handleCrossref,
	handleIacr,
	handleOrcid,
	handleSemanticScholar,
	handlePubMed,
	handleRfc,
	// Security
	handleCisaKev,
	handleNvd,
	handleOsv,
	// Crypto
	handleCoinGecko,
	// Business
	handleOpenCorporates,
	handleSecEdgar,
	// Reference
	handleOpenLibrary,
	handleChooseALicense,
	handleW3c,
	handleSpdx,
	handleWikidata,
	handleWikipedia,
];
