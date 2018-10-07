<?php
require_once('vendor/autoload.php');

$url = $_SERVER['REQUEST_URI'];
list(,$type,$id) = explode('/', $url);

function durl($id) {
  $s = new SteamID( $id );
  $s3 = $s->RenderSteam3();
  preg_match('/\[U:\d:(\d+)\]/', $s3, $m);
  $steam = $m[1];
  return 'https://www.dotabuff.com/players/'.$steam;
}

function dUrlRedirect($id) {
  header( 'Location: '.durl($id) );
}

if($type == 'profiles') {
  dUrlRedirect($id);
} elseif($type == 'id') {
  $json = json_decode(file_get_contents('http://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=DB3924CFFCBD62DF56A4C109BC806985&vanityurl='.$id));
  dUrlRedirect($json->response->steamid);
} else {
  header('Location: https://steamcommunity.com');
  die('Not supported url type: '. $type. '. Please use full steamcommunity url.');
}
