const base = "https://www.dotabuff.com/"
const statusCode = 301

async function handleRequest(request) {
//  const url = new URL('https://steamcommunity.com/profile/76561198025067497/')
  const url = new URL(request.url)
  const { pathname, search } = url
  var [ , linktype, linkid ] = pathname.split('/')

  if(!linktype || !linkid) return Response.redirect(base, statusCode)
  if(linktype == 'id') var linkid = await getId(linkid)

  const destinationURL = base + 'players/' + linkid

  return Response.redirect(destinationURL, statusCode)
}

addEventListener("fetch", async event => {
  event.respondWith(handleRequest(event.request))
})

async function gatherFetchResponse(response) {
  const { headers } = response
  const contentType = headers.get("content-type") || ""
  r = await response.json()
  return r.response.steamid
}

async function getId(id) {
  const url = 'http://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=DB3924CFFCBD62DF56A4C109BC806985&vanityurl=' + id
  const init = {
    headers: {
      "content-type": "application/json;charset=UTF-8",
    },
  }
  const response = await fetch(url, init)
  const data = await gatherFetchResponse(response)
  return data
}

addEventListener("fetch", event => {
  return event.respondWith(handleRequest())
})
