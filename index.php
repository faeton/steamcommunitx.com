<?php
require_once('vendor/autoload.php');

$url = $_SERVER['REQUEST_URI'];
list(,$type,$id) = explode('/', $url);

if($type == 'profiles') {
  // print $id;
  $s = new SteamID( $id );
  $s3 = $s->RenderSteam3();
  preg_match('/\[U:\d:(\d+)\]/', $s3, $m);
  $steam = $m[1];
  $durl = 'https://www.dotabuff.com/players/'.$steam;
  header('Location: '.$durl);
} else {
  die('Not supported url type: '. $type);
}
