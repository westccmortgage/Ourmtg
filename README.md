# Private Note Capital

Static site (no build step). `index.html` + `styles.css`, served from the repo
root by Netlify (`netlify.toml`: publish = "."). The "request access" form uses
Netlify Forms (`data-netlify="true"`), detected automatically at deploy.

> This lives on branch `claude/new-branch` of the Ourmtg repo as a temporary
> host because the standalone Private-Note-Capital repo isn't writable from the
> build session. Move to its own repo once that repo is granted write access.
